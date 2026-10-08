-- 1. Document phase + parser version -------------------------------------
ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS phase text NOT NULL DEFAULT 'uploading',
  ADD COLUMN IF NOT EXISTS parser_version integer NOT NULL DEFAULT 1;

ALTER TABLE public.documents DROP CONSTRAINT IF EXISTS documents_phase_check;
ALTER TABLE public.documents ADD CONSTRAINT documents_phase_check CHECK (
  phase IN ('uploading','queued','validating','parsing','chunking','embedding','indexing','ready','failed','deleting')
);

-- 2. Chunk provenance + idempotency ---------------------------------------
ALTER TABLE public.document_chunks
  ADD COLUMN IF NOT EXISTS chunking_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS embedding_model text;

DELETE FROM public.document_chunks a
USING public.document_chunks b
WHERE a.document_id = b.document_id
  AND a.chunk_index = b.chunk_index
  AND a.ctid > b.ctid;

CREATE UNIQUE INDEX IF NOT EXISTS document_chunks_doc_index_key
  ON public.document_chunks (document_id, chunk_index);

-- 3. Durable ingestion job queue ------------------------------------------
CREATE TABLE IF NOT EXISTS public.ingestion_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued',
  kind text NOT NULL DEFAULT 'ingest',
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 4,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  started_at timestamptz,
  completed_at timestamptz,
  error_code text,
  error_message text,
  worker_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ingestion_jobs_status_check
    CHECK (status IN ('queued','running','succeeded','failed','retrying'))
);

GRANT SELECT, INSERT ON public.ingestion_jobs TO authenticated;
GRANT ALL ON public.ingestion_jobs TO service_role;

ALTER TABLE public.ingestion_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ingestion_jobs_select_own ON public.ingestion_jobs;
CREATE POLICY ingestion_jobs_select_own ON public.ingestion_jobs
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS ingestion_jobs_insert_own ON public.ingestion_jobs;
-- WITH CHECK has to prove ownership of the *document*, not just of the job row.
-- `auth.uid() = user_id` alone lets any authenticated caller enqueue a job whose
-- document_id belongs to someone else: the row looks like theirs, so the policy
-- passes. The worker then refuses to act on it, because every document read below
-- is scoped by user_id as well -- but the insert has already taken the single live
-- slot for that document (ingestion_jobs_one_live_per_document is unique on
-- document_id alone), so the real owner's upload can no longer enqueue. That is a
-- cross-tenant denial of service reachable from any signed-in session.
--
-- The subquery is evaluated as the caller, so RLS on documents already limits it
-- to their own rows; the explicit `d.user_id = auth.uid()` keeps the check correct
-- on its own terms rather than depending on another table's policy.
CREATE POLICY ingestion_jobs_insert_own ON public.ingestion_jobs
  FOR INSERT TO authenticated WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.documents d
      WHERE d.id = document_id
        AND d.user_id = auth.uid()
    )
  );

-- Only one live job per document: retries reuse the same row.
CREATE UNIQUE INDEX IF NOT EXISTS ingestion_jobs_one_live_per_document
  ON public.ingestion_jobs (document_id)
  WHERE status IN ('queued','running','retrying');

CREATE INDEX IF NOT EXISTS ingestion_jobs_ready_idx
  ON public.ingestion_jobs (available_at)
  WHERE status IN ('queued','retrying');

DROP TRIGGER IF EXISTS ingestion_jobs_updated_at ON public.ingestion_jobs;
CREATE TRIGGER ingestion_jobs_updated_at
  BEFORE UPDATE ON public.ingestion_jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 4. Atomic claim (skip-locked) -------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_ingestion_jobs(
  worker_id text,
  worker_version text DEFAULT '1',
  max_jobs integer DEFAULT 1,
  lock_seconds integer DEFAULT 300,
  only_user_id uuid DEFAULT NULL
)
RETURNS SETOF public.ingestion_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.ingestion_jobs j
  SET status = 'running',
      attempt_count = j.attempt_count + 1,
      locked_at = now(),
      locked_by = worker_id,
      started_at = COALESCE(j.started_at, now()),
      worker_version = claim_ingestion_jobs.worker_version
  WHERE j.id IN (
    SELECT c.id
    FROM public.ingestion_jobs c
    WHERE (
        (c.status IN ('queued','retrying') AND c.available_at <= now())
        -- reclaim jobs whose worker died mid-run
        OR (c.status = 'running' AND c.locked_at < now() - make_interval(secs => lock_seconds))
      )
      AND (only_user_id IS NULL OR c.user_id = only_user_id)
    ORDER BY c.available_at
    FOR UPDATE SKIP LOCKED
    LIMIT GREATEST(LEAST(max_jobs, 5), 1)
  )
  RETURNING j.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_ingestion_jobs(text, text, integer, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ingestion_jobs(text, text, integer, integer, uuid) TO service_role;

-- 5. Drop chunks left behind by an older pipeline version ------------------
CREATE OR REPLACE FUNCTION public.prune_stale_chunks(
  target_document_id uuid,
  keep_chunking_version integer,
  keep_max_index integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  removed integer;
BEGIN
  DELETE FROM public.document_chunks c
  WHERE c.document_id = target_document_id
    AND (c.chunking_version <> keep_chunking_version OR c.chunk_index > keep_max_index);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;

REVOKE ALL ON FUNCTION public.prune_stale_chunks(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_stale_chunks(uuid, integer, integer) TO service_role;