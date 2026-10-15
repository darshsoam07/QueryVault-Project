-- ===========================================================================
-- QueryVault — GENERATED bootstrap script. DO NOT EDIT BY HAND.
--
-- Every migration in supabase/migrations/, concatenated in filename order.
-- Use when you have no Supabase CLI / psql access: paste the whole file into
-- Supabase Dashboard -> SQL Editor -> Run. Safe to run on an empty project.
--
-- Regenerate after adding a migration:
--   bash scripts/generate-bootstrap.sh
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 20260814130517_796d00bc-92d6-460e-a45a-3a54b7a6f492.sql
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS vector;

-- profiles
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,
  display_name TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "profiles_own" ON public.profiles FOR ALL TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- documents
CREATE TABLE public.documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  filename TEXT NOT NULL,
  storage_path TEXT,
  byte_size BIGINT NOT NULL DEFAULT 0,
  page_count INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'uploading',
  progress INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX documents_user_idx ON public.documents (user_id, created_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.documents TO authenticated;
GRANT ALL ON public.documents TO service_role;
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "documents_own" ON public.documents FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- document chunks
CREATE TABLE public.document_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  content TEXT NOT NULL,
  page_number INTEGER NOT NULL DEFAULT 1,
  chunk_index INTEGER NOT NULL DEFAULT 0,
  token_estimate INTEGER NOT NULL DEFAULT 0,
  embedding halfvec(3072),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX document_chunks_doc_idx ON public.document_chunks (document_id, chunk_index);
CREATE INDEX document_chunks_user_idx ON public.document_chunks (user_id);
CREATE INDEX document_chunks_embedding_idx ON public.document_chunks USING hnsw (embedding halfvec_cosine_ops);
CREATE INDEX document_chunks_content_fts_idx ON public.document_chunks USING gin (to_tsvector('english', content));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_chunks TO authenticated;
GRANT ALL ON public.document_chunks TO service_role;
ALTER TABLE public.document_chunks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "document_chunks_own" ON public.document_chunks FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- threads
CREATE TABLE public.threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New chat',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX threads_user_idx ON public.threads (user_id, updated_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.threads TO authenticated;
GRANT ALL ON public.threads TO service_role;
ALTER TABLE public.threads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "threads_own" ON public.threads FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- messages
CREATE TABLE public.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES public.threads(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  latency_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX messages_thread_idx ON public.messages (thread_id, created_at);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.messages TO authenticated;
GRANT ALL ON public.messages TO service_role;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "messages_own" ON public.messages FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE TRIGGER profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER documents_updated_at BEFORE UPDATE ON public.documents FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER threads_updated_at BEFORE UPDATE ON public.threads FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- new user profile
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)))
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- semantic retrieval
CREATE OR REPLACE FUNCTION public.match_document_chunks(
  query_embedding halfvec(3072),
  match_count INTEGER DEFAULT 5,
  document_ids UUID[] DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  document_id UUID,
  filename TEXT,
  content TEXT,
  page_number INTEGER,
  chunk_index INTEGER,
  similarity DOUBLE PRECISION
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT c.id, c.document_id, d.filename, c.content, c.page_number, c.chunk_index,
         1 - (c.embedding <=> query_embedding) AS similarity
  FROM public.document_chunks c
  JOIN public.documents d ON d.id = c.document_id
  WHERE c.embedding IS NOT NULL
    AND (document_ids IS NULL OR c.document_id = ANY(document_ids))
  ORDER BY c.embedding <=> query_embedding
  LIMIT GREATEST(match_count, 1);
$$;

GRANT EXECUTE ON FUNCTION public.match_document_chunks(halfvec, INTEGER, UUID[]) TO authenticated;

-- ---------------------------------------------------------------------------
-- 20260814130541_dcb6857f-c5cb-41e5-b8e4-e87ac1356464.sql
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO service_role, supabase_auth_admin;

-- ---------------------------------------------------------------------------
-- 20260814130616_f103b815-8c33-4023-b69c-5041ebe690dc.sql
-- ---------------------------------------------------------------------------
CREATE POLICY "documents_read_own" ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'documents' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "documents_insert_own" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'documents' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "documents_delete_own" ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'documents' AND (storage.foldername(name))[1] = auth.uid()::text);

-- ---------------------------------------------------------------------------
-- 20260814140015_3869a9d7-8a6c-470c-ab59-42906162d762.sql
-- ---------------------------------------------------------------------------
-- 1. Document integrity + lifecycle columns
ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS content_hash text,
  ADD COLUMN IF NOT EXISTS ingestion_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS chunking_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS embedding_model text,
  ADD COLUMN IF NOT EXISTS embedding_dimension integer,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS failure_code text,
  ADD COLUMN IF NOT EXISTS failure_message text,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0;

-- Normalise legacy statuses onto the new state machine
UPDATE public.documents SET status = 'uploaded' WHERE status IN ('uploading', 'queued');
UPDATE public.documents SET status = 'failed'
  WHERE status NOT IN ('uploaded','validating','stored','processing','ready','failed','deleting');

ALTER TABLE public.documents DROP CONSTRAINT IF EXISTS documents_status_check;
ALTER TABLE public.documents ADD CONSTRAINT documents_status_check
  CHECK (status IN ('uploaded','validating','stored','processing','ready','failed','deleting'));
ALTER TABLE public.documents ALTER COLUMN status SET DEFAULT 'uploaded';

-- Duplicate upload protection (per owner)
CREATE UNIQUE INDEX IF NOT EXISTS documents_user_content_hash_key
  ON public.documents (user_id, content_hash)
  WHERE content_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS documents_user_status_idx ON public.documents (user_id, status);

-- 2. State machine enforcement
CREATE OR REPLACE FUNCTION public.enforce_document_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  allowed text[];
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  allowed := CASE OLD.status
    WHEN 'uploaded'   THEN ARRAY['validating','failed','deleting']
    WHEN 'validating' THEN ARRAY['stored','failed','deleting']
    WHEN 'stored'     THEN ARRAY['processing','failed','deleting']
    WHEN 'processing' THEN ARRAY['ready','failed','deleting']
    WHEN 'ready'      THEN ARRAY['processing','deleting']
    WHEN 'failed'     THEN ARRAY['validating','processing','deleting']
    WHEN 'deleting'   THEN ARRAY[]::text[]
    ELSE ARRAY[]::text[]
  END;

  IF NOT (NEW.status = ANY (allowed)) THEN
    RAISE EXCEPTION 'Illegal document status transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS documents_transition_guard ON public.documents;
CREATE TRIGGER documents_transition_guard
  BEFORE UPDATE OF status ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.enforce_document_transition();

-- 3. Tenant-aware retrieval
DROP FUNCTION IF EXISTS public.match_document_chunks(halfvec, integer, uuid[]);

CREATE OR REPLACE FUNCTION public.match_document_chunks(
  query_embedding halfvec,
  requesting_user_id uuid,
  match_count integer DEFAULT 6,
  document_ids uuid[] DEFAULT NULL,
  min_similarity double precision DEFAULT 0.25
)
RETURNS TABLE(
  id uuid,
  document_id uuid,
  filename text,
  content text,
  page_number integer,
  chunk_index integer,
  similarity double precision
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT c.id, c.document_id, d.filename, c.content, c.page_number, c.chunk_index,
         1 - (c.embedding <=> query_embedding) AS similarity
  FROM public.document_chunks c
  JOIN public.documents d ON d.id = c.document_id
  WHERE c.embedding IS NOT NULL
    AND requesting_user_id IS NOT NULL
    AND auth.uid() = requesting_user_id
    AND c.user_id = requesting_user_id
    AND d.user_id = requesting_user_id
    AND d.status = 'ready'
    AND (document_ids IS NULL OR c.document_id = ANY(document_ids))
    AND (1 - (c.embedding <=> query_embedding)) >= min_similarity
  ORDER BY c.embedding <=> query_embedding
  LIMIT GREATEST(LEAST(match_count, 20), 1);
$$;

REVOKE ALL ON FUNCTION public.match_document_chunks(halfvec, uuid, integer, uuid[], double precision) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.match_document_chunks(halfvec, uuid, integer, uuid[], double precision) TO authenticated, service_role;

-- 4. Application-level rate limiting
CREATE TABLE IF NOT EXISTS public.rate_limit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bucket text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, DELETE ON public.rate_limit_events TO authenticated;
GRANT ALL ON public.rate_limit_events TO service_role;

ALTER TABLE public.rate_limit_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rate_limit_events_own ON public.rate_limit_events;
CREATE POLICY rate_limit_events_own ON public.rate_limit_events
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS rate_limit_events_lookup_idx
  ON public.rate_limit_events (user_id, bucket, created_at DESC);

-- ---------------------------------------------------------------------------
-- 20260814140649_650574de-6451-432c-8751-add3647bde5f.sql
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS documents_insert_own ON storage.objects;
CREATE POLICY documents_insert_own ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'documents'
    AND (storage.foldername(name))[1] = (auth.uid())::text
    AND name ILIKE '%.pdf'
  );

DROP POLICY IF EXISTS documents_update_own ON storage.objects;
CREATE POLICY documents_update_own ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'documents'
    AND (storage.foldername(name))[1] = (auth.uid())::text
  )
  WITH CHECK (
    bucket_id = 'documents'
    AND (storage.foldername(name))[1] = (auth.uid())::text
    AND name ILIKE '%.pdf'
  );

-- ---------------------------------------------------------------------------
-- 20260814140933_a2178045-05a5-4044-85c0-b58e1682874d.sql
-- ---------------------------------------------------------------------------
ALTER TABLE public.document_chunks
  ADD COLUMN IF NOT EXISTS content_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED;

CREATE INDEX IF NOT EXISTS document_chunks_content_tsv_idx
  ON public.document_chunks USING gin (content_tsv);

CREATE OR REPLACE FUNCTION public.lexical_document_chunks(
  query_text text,
  requesting_user_id uuid,
  match_count integer DEFAULT 20,
  document_ids uuid[] DEFAULT NULL::uuid[]
)
RETURNS TABLE(
  id uuid,
  document_id uuid,
  filename text,
  content text,
  page_number integer,
  chunk_index integer,
  lexical_rank double precision
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  WITH q AS (
    SELECT websearch_to_tsquery('english', coalesce(query_text, '')) AS tsq
  )
  SELECT c.id, c.document_id, d.filename, c.content, c.page_number, c.chunk_index,
         ts_rank_cd(c.content_tsv, q.tsq)::double precision AS lexical_rank
  FROM public.document_chunks c
  JOIN public.documents d ON d.id = c.document_id
  CROSS JOIN q
  WHERE q.tsq IS NOT NULL
    AND numnode(q.tsq) > 0
    AND requesting_user_id IS NOT NULL
    AND auth.uid() = requesting_user_id
    AND c.user_id = requesting_user_id
    AND d.user_id = requesting_user_id
    AND d.status = 'ready'
    AND (document_ids IS NULL OR c.document_id = ANY(document_ids))
    AND c.content_tsv @@ q.tsq
  ORDER BY lexical_rank DESC
  LIMIT GREATEST(LEAST(match_count, 20), 1);
$function$;

REVOKE ALL ON FUNCTION public.lexical_document_chunks(text, uuid, integer, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lexical_document_chunks(text, uuid, integer, uuid[]) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 20260814141928_cccb7a84-a6be-4655-8bfe-a3767760aeee.sql
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 20260814142729_b597f951-a84f-4a6d-839b-b03ae0d934c3.sql
-- ---------------------------------------------------------------------------
-- 1. Roles (separate table, never on profiles)
DO $$ BEGIN
  CREATE TYPE public.app_role AS ENUM ('admin', 'operator', 'user');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);

GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_roles_read_own ON public.user_roles;
CREATE POLICY user_roles_read_own ON public.user_roles
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  );
$$;

CREATE OR REPLACE FUNCTION public.is_operator(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role IN ('admin', 'operator')
  );
$$;

REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_operator(uuid) FROM anon;

-- 2. Structured telemetry events
CREATE TABLE IF NOT EXISTS public.telemetry_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id text NOT NULL,
  event text NOT NULL,
  status text NOT NULL DEFAULT 'ok',
  error_code text,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  document_id uuid,
  thread_id uuid,
  job_id uuid,
  latency_ms integer,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.telemetry_events TO authenticated;
GRANT ALL ON public.telemetry_events TO service_role;

ALTER TABLE public.telemetry_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS telemetry_events_read_own ON public.telemetry_events;
CREATE POLICY telemetry_events_read_own ON public.telemetry_events
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.is_operator(auth.uid()));

CREATE INDEX IF NOT EXISTS telemetry_events_created_idx ON public.telemetry_events (created_at DESC);
CREATE INDEX IF NOT EXISTS telemetry_events_event_idx ON public.telemetry_events (event, created_at DESC);
CREATE INDEX IF NOT EXISTS telemetry_events_request_idx ON public.telemetry_events (request_id);

-- 3. Query traces for the operator debug view
CREATE TABLE IF NOT EXISTS public.query_traces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  thread_id uuid,
  question text NOT NULL,
  answer_preview text,
  grounded boolean NOT NULL DEFAULT false,
  refused boolean NOT NULL DEFAULT false,
  gate_reason text,
  reranker text,
  stages jsonb NOT NULL DEFAULT '{}'::jsonb,
  citations jsonb NOT NULL DEFAULT '[]'::jsonb,
  retrieval_latency_ms integer,
  generation_latency_ms integer,
  total_latency_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.query_traces TO authenticated;
GRANT ALL ON public.query_traces TO service_role;

ALTER TABLE public.query_traces ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS query_traces_read_own ON public.query_traces;
CREATE POLICY query_traces_read_own ON public.query_traces
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.is_operator(auth.uid()));

CREATE INDEX IF NOT EXISTS query_traces_created_idx ON public.query_traces (created_at DESC);
CREATE INDEX IF NOT EXISTS query_traces_request_idx ON public.query_traces (request_id);

-- 4. Operator-only metrics rollup
CREATE OR REPLACE FUNCTION public.observability_summary(window_minutes integer DEFAULT 60)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  since timestamptz := now() - make_interval(mins => GREATEST(LEAST(window_minutes, 10080), 5));
  api jsonb;
  rag jsonb;
  ingestion jsonb;
  cost jsonb;
BEGIN
  IF NOT public.is_operator(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT jsonb_build_object(
    'requests', count(*),
    'errors', count(*) FILTER (WHERE status = 'error'),
    'error_rate', CASE WHEN count(*) = 0 THEN 0
      ELSE round((count(*) FILTER (WHERE status = 'error'))::numeric / count(*), 4) END,
    'p50_ms', coalesce(percentile_disc(0.5) WITHIN GROUP (ORDER BY latency_ms), 0),
    'p95_ms', coalesce(percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms), 0),
    'p99_ms', coalesce(percentile_disc(0.99) WITHIN GROUP (ORDER BY latency_ms), 0)
  ) INTO api
  FROM public.telemetry_events
  WHERE created_at >= since
    AND event IN ('generation.completed','generation.failed','document.uploaded','document.deleted','document.validation_failed');

  SELECT jsonb_build_object(
    'retrieval_p50_ms', coalesce(percentile_disc(0.5) WITHIN GROUP (
      ORDER BY (attributes->>'retrieval_latency_ms')::int), 0),
    'retrieval_p95_ms', coalesce(percentile_disc(0.95) WITHIN GROUP (
      ORDER BY (attributes->>'retrieval_latency_ms')::int), 0),
    'generation_p50_ms', coalesce(percentile_disc(0.5) WITHIN GROUP (
      ORDER BY (attributes->>'generation_latency_ms')::int), 0),
    'generation_p95_ms', coalesce(percentile_disc(0.95) WITHIN GROUP (
      ORDER BY (attributes->>'generation_latency_ms')::int), 0),
    'answers', count(*) FILTER (WHERE event = 'generation.completed'),
    'grounded', count(*) FILTER (WHERE (attributes->>'grounded')::boolean IS TRUE),
    'refusals', count(*) FILTER (WHERE (attributes->>'refused')::boolean IS TRUE),
    'avg_hits', coalesce(round(avg((attributes->>'final_evidence')::numeric), 2), 0),
    'avg_best_similarity', coalesce(round(avg((attributes->>'best_similarity')::numeric), 4), 0),
    'avg_best_rerank', coalesce(round(avg((attributes->>'best_rerank_score')::numeric), 4), 0)
  ) INTO rag
  FROM public.telemetry_events
  WHERE created_at >= since
    AND event IN ('retrieval.completed','generation.completed','generation.failed');

  SELECT jsonb_build_object(
    'queued', count(*) FILTER (WHERE status = 'queued'),
    'running', count(*) FILTER (WHERE status = 'running'),
    'retrying', count(*) FILTER (WHERE status = 'retrying'),
    'failed', count(*) FILTER (WHERE status = 'failed'),
    'succeeded', count(*) FILTER (WHERE status = 'succeeded'),
    'retries', coalesce(sum(GREATEST(attempt_count - 1, 0)), 0),
    'avg_duration_ms', coalesce(round(avg(
      CASE WHEN completed_at IS NOT NULL AND started_at IS NOT NULL
        THEN EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000 END), 0), 0)
  ) INTO ingestion
  FROM public.ingestion_jobs
  WHERE created_at >= since;

  SELECT jsonb_build_object(
    'embedding_calls', coalesce(sum((attributes->>'embedding_calls')::int), 0),
    'embedded_texts', coalesce(sum((attributes->>'embedded_texts')::int), 0),
    'generation_calls', count(*) FILTER (WHERE event = 'generation.completed'),
    'prompt_tokens', coalesce(sum((attributes->>'prompt_tokens')::int), 0),
    'completion_tokens', coalesce(sum((attributes->>'completion_tokens')::int), 0),
    'context_tokens', coalesce(sum((attributes->>'context_tokens')::int), 0)
  ) INTO cost
  FROM public.telemetry_events
  WHERE created_at >= since;

  RETURN jsonb_build_object(
    'window_minutes', GREATEST(LEAST(window_minutes, 10080), 5),
    'since', since,
    'api', coalesce(api, '{}'::jsonb),
    'rag', coalesce(rag, '{}'::jsonb),
    'ingestion', coalesce(ingestion, '{}'::jsonb),
    'cost', coalesce(cost, '{}'::jsonb)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.observability_summary(integer) FROM anon;

-- ---------------------------------------------------------------------------
-- 20260814142812_ac3fecd7-30d5-4625-9b5d-7316f039c845.sql
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_operator(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.observability_summary(integer) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_operator(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.observability_summary(integer) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 20260814145941_999de10b-ba3b-428c-966b-f1ce604ff581.sql
-- ---------------------------------------------------------------------------
-- 1. rate_limit_events: server-owned state only
DROP POLICY IF EXISTS rate_limit_events_own ON public.rate_limit_events;
REVOKE ALL ON public.rate_limit_events FROM authenticated, anon;
GRANT ALL ON public.rate_limit_events TO service_role;

-- 2. document_chunks: client read-only, worker writes
DROP POLICY IF EXISTS document_chunks_own ON public.document_chunks;
CREATE POLICY document_chunks_select_own ON public.document_chunks
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
REVOKE INSERT, UPDATE, DELETE ON public.document_chunks FROM authenticated, anon;
GRANT SELECT ON public.document_chunks TO authenticated;
GRANT ALL ON public.document_chunks TO service_role;

-- 3. documents: client may read + delete own; pipeline fields are server-written
DROP POLICY IF EXISTS documents_own ON public.documents;
CREATE POLICY documents_select_own ON public.documents
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY documents_delete_own ON public.documents
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);
REVOKE INSERT, UPDATE ON public.documents FROM authenticated, anon;
GRANT SELECT, DELETE ON public.documents TO authenticated;
GRANT ALL ON public.documents TO service_role;

-- ---------------------------------------------------------------------------
-- 20260814150211_0611d3ed-fac0-4dd2-a38e-31bc26df2431.sql
-- ---------------------------------------------------------------------------
CREATE TABLE public.worker_credentials (
  name text PRIMARY KEY,
  token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Server-only: no grants to anon/authenticated at all.
GRANT ALL ON public.worker_credentials TO service_role;

ALTER TABLE public.worker_credentials ENABLE ROW LEVEL SECURITY;
-- Intentionally no policies: service_role bypasses RLS, every other role is denied.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ---------------------------------------------------------------------------
-- 20260814150409_2b2199b5-581e-4edf-9449-c570367863ec.sql
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.worker_credentials FROM authenticated, anon, PUBLIC;
GRANT ALL ON public.worker_credentials TO service_role;

-- ---------------------------------------------------------------------------
-- 20260820000000_provision_documents_bucket.sql
-- ---------------------------------------------------------------------------
-- Storage bucket provisioning.
--
-- Until now the `documents` bucket was a manual dashboard step recorded only in
-- supabase/STORAGE.md, while its RLS policies lived in migrations
-- (20260814130616 / 20260814140649). A fresh environment therefore got the
-- policies but no bucket, and every upload failed with "Bucket not found".
-- This makes provisioning fully reproducible from migrations alone.
--
-- Limits mirror src/lib/documents.policy.ts (MAX_UPLOAD_BYTES = 25 MiB) and are
-- defence in depth, not the primary check: the server still re-verifies size,
-- content type and %PDF- magic bytes after upload, because a bucket-level MIME
-- allowlist trusts the client-declared Content-Type.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('documents', 'documents', false, 26214400, ARRAY['application/pdf'])
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;


-- ---------------------------------------------------------------------------
-- 20260822000000_drop_redundant_fts_index.sql
-- ---------------------------------------------------------------------------
-- Drop the redundant full-text index on document_chunks.
--
-- Two GIN indexes covered the same text:
--
--   document_chunks_content_fts_idx  ON ... USING gin (to_tsvector('english', content))
--   document_chunks_content_tsv_idx  ON ... USING gin (content_tsv)
--
-- The first was created before `content_tsv` existed. Migration
-- 20260814140933 added `content_tsv` as a STORED generated column with the
-- identical expression, indexed it, and rewrote `lexical_document_chunks` to
-- filter on `c.content_tsv @@ q.tsq`. Every lexical query has gone through the
-- column since; nothing references the expression form.
--
-- Keeping it is not free. A GIN index over the tokenised text of every chunk is
-- one of the larger objects in the database, and it has to be maintained on
-- every chunk insert — which is the write-heaviest path in the system, since
-- ingesting one document writes hundreds of chunks in batches. Paying that twice
-- to serve zero queries is pure overhead.
--
-- Dropping an unused index cannot change a query result, only a plan, and no
-- plan referenced this one.
--
-- Rollback: recreate it with
--   CREATE INDEX document_chunks_content_fts_idx
--     ON public.document_chunks USING gin (to_tsvector('english', content));
-- Expect a full index build; on a large corpus prefer CONCURRENTLY.

DROP INDEX IF EXISTS public.document_chunks_content_fts_idx;


-- ---------------------------------------------------------------------------
-- 20260904000000_schedule_ingestion_worker.sql
-- ---------------------------------------------------------------------------
-- Durable ingestion scheduler ------------------------------------------------
--
-- The application owns ingestion execution; this migration only wakes the
-- existing authenticated /api/public/worker-drain endpoint once per minute.
-- Jobs remain claimed, retried and made idempotent by the Node worker.
--
-- Before enabling production traffic, store these two values in Supabase Vault:
--   queryvault_worker_drain_url       the deployed HTTPS endpoint URL
--   queryvault_ingestion_worker_secret the same value injected as
--                                      INGESTION_WORKER_SECRET in the app
--
-- They are intentionally looked up at execution time. No endpoint URL or
-- credential is baked into a migration, cron command, table, or application
-- bundle. If either is absent the scheduled no-op is safe and fail-closed.

CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;

CREATE OR REPLACE FUNCTION public.trigger_ingestion_worker()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions
AS $$
DECLARE
  worker_url text;
  worker_secret text;
BEGIN
  SELECT decrypted_secret
    INTO worker_url
    FROM vault.decrypted_secrets
   WHERE name = 'queryvault_worker_drain_url';

  SELECT decrypted_secret
    INTO worker_secret
    FROM vault.decrypted_secrets
   WHERE name = 'queryvault_ingestion_worker_secret';

  -- A scheduler that cannot authenticate must never turn the endpoint public,
  -- and must not create a failing pg_net request every minute.
  IF worker_url IS NULL OR worker_url = '' OR worker_secret IS NULL OR worker_secret = '' THEN
    RETURN false;
  END IF;

  PERFORM net.http_post(
    url := worker_url,
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-worker-secret', worker_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 1_000
  );

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.trigger_ingestion_worker() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_ingestion_worker() TO service_role;

-- Keep a single named schedule. Re-running the migration does not create a
-- competing worker; changing its cadence is a deliberate future migration.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM cron.job
     WHERE jobname = 'queryvault-ingestion-worker'
  ) THEN
    PERFORM cron.schedule(
      'queryvault-ingestion-worker',
      '* * * * *',
      'SELECT public.trigger_ingestion_worker();'
    );
  END IF;
END;
$$;


-- ---------------------------------------------------------------------------
-- 20260908000000_ip_rate_limit_and_prune.sql
-- ---------------------------------------------------------------------------
-- Migration: IP-level burst rate limiting + prune helper  (Phase 5)
-- Non-destructive: only adds new table and functions.

CREATE TABLE IF NOT EXISTS public.rate_limits_ip (
  ip              text        NOT NULL,
  window_start    timestamptz NOT NULL,
  request_count   integer     NOT NULL DEFAULT 1,
  CONSTRAINT pk_rate_limits_ip PRIMARY KEY (ip, window_start)
);
ALTER TABLE public.rate_limits_ip ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rate_limits_ip FROM anon, authenticated;
GRANT ALL ON public.rate_limits_ip TO service_role;
CREATE INDEX IF NOT EXISTS idx_rate_limits_ip_window ON public.rate_limits_ip (window_start);

-- 50 req / 10 s sliding window per IP.
CREATE OR REPLACE FUNCTION public.check_ip_rate_limit(
  p_ip text, p_max integer DEFAULT 50, p_window interval DEFAULT '10 seconds'
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_window_start timestamptz;
  v_count        integer;
BEGIN
  v_window_start := date_trunc('second', now()) -
    make_interval(secs => EXTRACT(EPOCH FROM now())::int % EXTRACT(EPOCH FROM p_window)::int);
  INSERT INTO public.rate_limits_ip (ip, window_start, request_count)
    VALUES (p_ip, v_window_start, 1)
    ON CONFLICT (ip, window_start) DO UPDATE
      SET request_count = rate_limits_ip.request_count + 1
    RETURNING request_count INTO v_count;
  IF v_count > p_max THEN
    RETURN jsonb_build_object('allowed', false, 'retry_after_seconds',
      EXTRACT(EPOCH FROM (v_window_start + p_window - now()))::int);
  END IF;
  RETURN jsonb_build_object('allowed', true, 'retry_after_seconds', 0);
END;
$$;

REVOKE ALL ON FUNCTION public.check_ip_rate_limit(text, integer, interval) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_ip_rate_limit(text, integer, interval) TO service_role;

-- Cleans both rate_limit_events (user) and rate_limits_ip; called from worker drain.
-- References rate_limit_events (the original table name), NOT "rate_limits".
CREATE OR REPLACE FUNCTION public.prune_expired_rate_limits(
  p_older_than interval DEFAULT '1 hour'
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM public.rate_limits_ip WHERE window_start < now() - p_older_than;
  DELETE FROM public.rate_limit_events WHERE created_at < now() - p_older_than;
EXCEPTION
  WHEN undefined_table THEN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.prune_expired_rate_limits(interval) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.prune_expired_rate_limits(interval) TO service_role;



-- ---------------------------------------------------------------------------
-- 20260908000001_health_probe_fn.sql
-- ---------------------------------------------------------------------------
-- Migration: health probe RPC  (Phase 6)
-- Used by GET /api/health. Cheap SELECT now() — no table scans.

CREATE OR REPLACE FUNCTION public.health_probe()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('ok', true, 'ts', now()::text);
$$;

REVOKE ALL ON FUNCTION public.health_probe() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.health_probe() TO service_role;



-- ---------------------------------------------------------------------------
-- 20261008000000_expand_document_formats.sql
-- ---------------------------------------------------------------------------
-- Format-aware ingestion. Existing PDFs retain their metadata; new files keep
-- their actual MIME type so the worker can route them to a local parser.
ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS content_type text NOT NULL DEFAULT 'application/pdf';

UPDATE storage.buckets
SET allowed_mime_types = ARRAY[
  'application/pdf', 'application/x-pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain', 'text/markdown', 'text/x-markdown', 'text/csv', 'application/csv',
  'text/html', 'application/xhtml+xml',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/png', 'image/jpeg', 'image/webp'
]
WHERE id = 'documents';

-- The original policies required a .pdf suffix. Keep ownership checks and
-- broaden only the allowed extensions used by the server validation layer.
DROP POLICY IF EXISTS documents_insert_own ON storage.objects;
CREATE POLICY documents_insert_own ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'documents' AND (storage.foldername(name))[1] = auth.uid()::text
  AND name ~* '\.(pdf|docx|txt|md|markdown|csv|html|htm|xlsx|pptx|png|jpe?g|webp)$'
);

DROP POLICY IF EXISTS documents_update_own ON storage.objects;
CREATE POLICY documents_update_own ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'documents' AND (storage.foldername(name))[1] = auth.uid()::text)
WITH CHECK (
  bucket_id = 'documents' AND (storage.foldername(name))[1] = auth.uid()::text
  AND name ~* '\.(pdf|docx|txt|md|markdown|csv|html|htm|xlsx|pptx|png|jpe?g|webp)$'
);


-- ---------------------------------------------------------------------------
-- 20261008000001_messages_pagination_index.sql
-- ---------------------------------------------------------------------------
-- Migration: 20261008000001_messages_pagination_index.sql
-- Optimizes cursor-based pagination for conversation messages:
-- WHERE thread_id = $1 AND (created_at < $2 OR (created_at = $2 AND id < $3))
-- ORDER BY created_at DESC, id DESC LIMIT 50

CREATE INDEX IF NOT EXISTS messages_thread_pagination_idx
  ON public.messages (thread_id, created_at DESC, id DESC);


-- ---------------------------------------------------------------------------
-- 20261015000000_atomic_upload_admission.sql
-- ---------------------------------------------------------------------------
-- Configure database-wide limits here; service role only. Changes take effect
-- immediately across all workers, independently of process environment.
CREATE TABLE IF NOT EXISTS public.ingestion_limits (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  queued_per_user integer NOT NULL DEFAULT 20 CHECK (queued_per_user > 0),
  pending_bytes bigint NOT NULL DEFAULT 209715200 CHECK (pending_bytes > 0),
  global_workers integer NOT NULL DEFAULT 3 CHECK (global_workers BETWEEN 1 AND 32)
);
ALTER TABLE public.ingestion_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ingestion_limits FROM anon, authenticated;
GRANT ALL ON public.ingestion_limits TO service_role;
INSERT INTO public.ingestion_limits(id) VALUES(true) ON CONFLICT DO NOTHING;

-- Serialize reservations per owner, including service-role inserts. Trigger runs
-- in the insert transaction, so simultaneous requests cannot both observe room.
CREATE OR REPLACE FUNCTION public.enforce_upload_admission()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE active_count integer; active_bytes bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id::text, 421));
  SELECT count(*), coalesce(sum(byte_size), 0) INTO active_count, active_bytes
    FROM public.documents WHERE user_id = NEW.user_id
      AND status IN ('uploaded', 'validating', 'stored', 'processing');
  IF active_count >= (SELECT queued_per_user FROM public.ingestion_limits WHERE id) OR active_bytes + NEW.byte_size > (SELECT pending_bytes FROM public.ingestion_limits WHERE id) THEN
    RAISE EXCEPTION 'Upload admission limit reached; wait for pending documents' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS enforce_upload_admission ON public.documents;
CREATE TRIGGER enforce_upload_admission BEFORE INSERT ON public.documents
FOR EACH ROW EXECUTE FUNCTION public.enforce_upload_admission();

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
DECLARE capacity integer;
BEGIN
  -- Global database ceiling, shared by overlapping drains and processes.
  PERFORM pg_advisory_xact_lock(421, 991);
  SELECT greatest(0, (SELECT global_workers FROM public.ingestion_limits WHERE id) - count(*))::integer INTO capacity
    FROM public.ingestion_jobs WHERE status = 'running'
      AND locked_at >= now() - make_interval(secs => lock_seconds);
  IF capacity = 0 THEN RETURN; END IF;
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
    LIMIT LEAST(capacity, GREATEST(LEAST(max_jobs, 5), 1))
  )
  RETURNING j.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_ingestion_jobs(text, text, integer, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ingestion_jobs(text, text, integer, integer, uuid) TO service_role;


-- All pipeline writes are fenced under the same row lock as reclaim. Document
-- lock serializes deletion with chunk writes and publication.
CREATE OR REPLACE FUNCTION public.mutate_ingestion_claim(
  job_id uuid, claim_worker text, claim_attempt integer,
  document_patch jsonb DEFAULT '{}'::jsonb, chunk_rows jsonb DEFAULT '[]'::jsonb,
  job_patch jsonb DEFAULT '{}'::jsonb, prune_max_index integer DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j public.ingestion_jobs; d public.documents; patched public.documents; jp public.ingestion_jobs;
BEGIN
  SELECT * INTO j FROM public.ingestion_jobs WHERE id = job_id FOR UPDATE;
  IF NOT FOUND OR j.status <> 'running' OR j.locked_by IS DISTINCT FROM claim_worker
    OR j.attempt_count <> claim_attempt OR j.locked_at < now() - interval '300 seconds' THEN RETURN false; END IF;
  SELECT * INTO d FROM public.documents WHERE id = j.document_id AND user_id = j.user_id FOR UPDATE;
  IF NOT FOUND OR d.status = 'deleting' THEN RETURN false; END IF;
  IF jsonb_array_length(chunk_rows) > 0 THEN
    IF EXISTS (SELECT 1 FROM jsonb_populate_recordset(NULL::public.document_chunks, chunk_rows) r
      WHERE r.document_id IS DISTINCT FROM j.document_id OR r.user_id IS DISTINCT FROM j.user_id) THEN RAISE EXCEPTION 'Invalid chunk owner'; END IF;
    INSERT INTO public.document_chunks (id, document_id, user_id, content, page_number, chunk_index, token_estimate, embedding, chunking_version, embedding_model)
      SELECT id, document_id, user_id, content, page_number, chunk_index, token_estimate, embedding, chunking_version, embedding_model
      FROM jsonb_populate_recordset(NULL::public.document_chunks, chunk_rows)
      ON CONFLICT (document_id, chunk_index) DO UPDATE SET id = EXCLUDED.id, content = EXCLUDED.content, embedding = EXCLUDED.embedding,
        page_number = EXCLUDED.page_number, token_estimate = EXCLUDED.token_estimate,
        chunking_version = EXCLUDED.chunking_version, embedding_model = EXCLUDED.embedding_model
        WHERE document_chunks.document_id = j.document_id AND document_chunks.user_id = j.user_id;
  END IF;
  IF prune_max_index IS NOT NULL THEN
    DELETE FROM public.document_chunks WHERE document_id = j.document_id
      AND (chunk_index > prune_max_index OR chunking_version <> (document_patch->>'chunking_version')::integer);
  END IF;
  IF document_patch->>'status' = 'ready' AND (
    prune_max_index IS NULL OR (SELECT count(*) FROM public.document_chunks
      WHERE document_id = j.document_id AND user_id = j.user_id AND embedding IS NOT NULL
        AND chunking_version = (document_patch->>'chunking_version')::integer
        AND chunk_index BETWEEN 0 AND prune_max_index) <> prune_max_index + 1
  ) THEN RAISE EXCEPTION 'Incomplete index cannot be published'; END IF;
  IF document_patch <> '{}'::jsonb THEN
    patched := jsonb_populate_record(d, document_patch);
    UPDATE public.documents SET status = patched.status, phase = patched.phase, progress = patched.progress,
      chunk_count = patched.chunk_count, page_count = patched.page_count, storage_path = patched.storage_path,
      byte_size = patched.byte_size, parser_version = patched.parser_version, chunking_version = patched.chunking_version,
      embedding_model = patched.embedding_model, embedding_dimension = patched.embedding_dimension,
      completed_at = patched.completed_at, failure_code = patched.failure_code,
      failure_message = patched.failure_message, error_message = patched.error_message WHERE id = d.id;
  END IF;
  IF job_patch <> '{}'::jsonb THEN
    jp := jsonb_populate_record(j, job_patch);
    UPDATE public.ingestion_jobs SET status = jp.status, available_at = jp.available_at,
      completed_at = jp.completed_at, locked_at = CASE WHEN jp.status = 'running' AND job_patch ? 'locked_at' THEN now() ELSE jp.locked_at END, locked_by = jp.locked_by,
      error_code = jp.error_code, error_message = jp.error_message WHERE id = j.id;
  END IF;
  RETURN true;
END; $$;
REVOKE ALL ON FUNCTION public.mutate_ingestion_claim(uuid,text,integer,jsonb,jsonb,jsonb,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mutate_ingestion_claim(uuid,text,integer,jsonb,jsonb,jsonb,integer) TO service_role;

-- Hide an old index as soon as reindex is admitted, before a worker claims it.
CREATE OR REPLACE FUNCTION public.hide_reindex_on_enqueue()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.documents SET status = 'processing', phase = 'queued', progress = 5
    WHERE id = NEW.document_id AND user_id = NEW.user_id AND status = 'ready';
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS hide_reindex_on_enqueue ON public.ingestion_jobs;
CREATE TRIGGER hide_reindex_on_enqueue AFTER INSERT ON public.ingestion_jobs
FOR EACH ROW EXECUTE FUNCTION public.hide_reindex_on_enqueue();

REVOKE ALL ON FUNCTION public.enforce_upload_admission() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hide_reindex_on_enqueue() FROM PUBLIC, anon, authenticated;

-- Relevance-ranked per-document candidate ceilings apply before the global limit.
CREATE OR REPLACE FUNCTION public.match_document_chunks(
  query_embedding halfvec,
  requesting_user_id uuid,
  match_count integer DEFAULT 6,
  document_ids uuid[] DEFAULT NULL,
  min_similarity double precision DEFAULT 0.25
)
RETURNS TABLE(
  id uuid,
  document_id uuid,
  filename text,
  content text,
  page_number integer,
  chunk_index integer,
  similarity double precision
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH eligible AS (
  SELECT c.id, c.document_id, d.filename, c.content, c.page_number, c.chunk_index,
         1 - (c.embedding <=> query_embedding) AS similarity
  FROM public.document_chunks c
  JOIN public.documents d ON d.id = c.document_id
  WHERE c.embedding IS NOT NULL
    AND requesting_user_id IS NOT NULL
    AND auth.uid() = requesting_user_id
    AND c.user_id = requesting_user_id
    AND d.user_id = requesting_user_id
    AND d.status = 'ready'
    AND (document_ids IS NULL OR c.document_id = ANY(document_ids))
    AND (1 - (c.embedding <=> query_embedding)) >= min_similarity
  ), ranked AS (
    SELECT eligible.*, row_number() OVER (PARTITION BY document_id ORDER BY similarity DESC, id) AS doc_rank FROM eligible
  )
  SELECT id, document_id, filename, content, page_number, chunk_index, similarity
  FROM ranked WHERE doc_rank <= CASE WHEN (SELECT count(DISTINCT document_id) FROM eligible) > 1 THEN 8 ELSE 60 END
  ORDER BY similarity DESC, id
  LIMIT GREATEST(LEAST(match_count, 60), 1);
$$;

REVOKE ALL ON FUNCTION public.match_document_chunks(halfvec, uuid, integer, uuid[], double precision) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.match_document_chunks(halfvec, uuid, integer, uuid[], double precision) TO authenticated, service_role;


CREATE OR REPLACE FUNCTION public.lexical_document_chunks(
  query_text text,
  requesting_user_id uuid,
  match_count integer DEFAULT 20,
  document_ids uuid[] DEFAULT NULL::uuid[]
)
RETURNS TABLE(
  id uuid,
  document_id uuid,
  filename text,
  content text,
  page_number integer,
  chunk_index integer,
  lexical_rank double precision
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  WITH q AS (
    SELECT websearch_to_tsquery('english', coalesce(query_text, '')) AS tsq
  ), eligible AS (
  SELECT c.id, c.document_id, d.filename, c.content, c.page_number, c.chunk_index,
         ts_rank_cd(c.content_tsv, q.tsq)::double precision AS lexical_rank
  FROM public.document_chunks c
  JOIN public.documents d ON d.id = c.document_id
  CROSS JOIN q
  WHERE q.tsq IS NOT NULL
    AND numnode(q.tsq) > 0
    AND requesting_user_id IS NOT NULL
    AND auth.uid() = requesting_user_id
    AND c.user_id = requesting_user_id
    AND d.user_id = requesting_user_id
    AND d.status = 'ready'
    AND (document_ids IS NULL OR c.document_id = ANY(document_ids))
    AND c.content_tsv @@ q.tsq
  ), ranked AS (
    SELECT eligible.*, row_number() OVER (PARTITION BY document_id ORDER BY lexical_rank DESC, id) AS doc_rank FROM eligible
  )
  SELECT id, document_id, filename, content, page_number, chunk_index, lexical_rank
  FROM ranked WHERE doc_rank <= CASE WHEN (SELECT count(DISTINCT document_id) FROM eligible) > 1 THEN 8 ELSE 60 END
  ORDER BY lexical_rank DESC, id
  LIMIT GREATEST(LEAST(match_count, 60), 1);
$function$;

REVOKE ALL ON FUNCTION public.lexical_document_chunks(text, uuid, integer, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lexical_document_chunks(text, uuid, integer, uuid[]) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 20261015010000_production_hardening.sql
-- ---------------------------------------------------------------------------
-- Forward-only hardening. Apply after the atomic upload admission migration.
CREATE OR REPLACE FUNCTION public.enforce_upload_admission()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE active_count integer; active_bytes bigint; limits public.ingestion_limits;
BEGIN
  IF NEW.status NOT IN ('uploaded','validating','stored','processing') THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IN ('uploaded','validating','stored','processing') AND NEW.byte_size <= OLD.byte_size THEN RETURN NEW; END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id::text, 421));
  SELECT * INTO limits FROM public.ingestion_limits WHERE id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ingestion limits are not configured' USING ERRCODE = 'P0001'; END IF;
  SELECT count(*), coalesce(sum(byte_size), 0) INTO active_count, active_bytes
    FROM public.documents WHERE user_id = NEW.user_id AND id <> NEW.id
      AND status IN ('uploaded', 'validating', 'stored', 'processing');
  IF active_count >= limits.queued_per_user OR active_bytes + NEW.byte_size > limits.pending_bytes THEN
    RAISE EXCEPTION 'Upload admission limit reached; wait for pending documents' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS enforce_upload_admission ON public.documents;
CREATE TRIGGER enforce_upload_admission BEFORE INSERT OR UPDATE OF status, byte_size ON public.documents
FOR EACH ROW EXECUTE FUNCTION public.enforce_upload_admission();

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
DECLARE capacity integer; exhausted public.ingestion_jobs;
BEGIN
  IF lock_seconds <> 300 OR lock_seconds IS NULL THEN RAISE EXCEPTION 'Lease duration must be 300 seconds' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ingestion_limits WHERE id) THEN RAISE EXCEPTION 'Ingestion limits are not configured'; END IF;
  -- Global database ceiling, shared by overlapping drains and processes.
  PERFORM pg_advisory_xact_lock(421, 991);
  FOR exhausted IN SELECT * FROM public.ingestion_jobs c
    WHERE c.attempt_count >= c.max_attempts AND (
      (c.status IN ('queued','retrying') AND c.available_at <= clock_timestamp()) OR
      (c.status = 'running' AND (c.locked_at IS NULL OR c.locked_at < clock_timestamp() - interval '300 seconds'))
    ) FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.ingestion_jobs SET status = 'failed', error_code = 'ATTEMPTS_EXHAUSTED',
      error_message = 'Worker recovery exhausted the retry limit.', locked_at = NULL, locked_by = NULL, completed_at = clock_timestamp() WHERE id = exhausted.id;
    UPDATE public.documents SET status = 'failed', phase = 'failed', failure_code = 'ATTEMPTS_EXHAUSTED', failure_message = 'Worker recovery exhausted the retry limit.'
      WHERE id = exhausted.document_id AND user_id = exhausted.user_id AND status IN ('uploaded','validating','stored','processing');
  END LOOP;
  SELECT greatest(0, (SELECT global_workers FROM public.ingestion_limits WHERE id) - count(*))::integer INTO capacity
    FROM public.ingestion_jobs WHERE status = 'running'
      AND locked_at >= clock_timestamp() - make_interval(secs => lock_seconds);
  IF capacity = 0 THEN RETURN; END IF;
  RETURN QUERY
  UPDATE public.ingestion_jobs j
  SET status = 'running',
      attempt_count = j.attempt_count + 1,
      locked_at = clock_timestamp(),
      locked_by = worker_id,
      started_at = COALESCE(j.started_at, clock_timestamp()),
      worker_version = claim_ingestion_jobs.worker_version
  WHERE j.id IN (
    SELECT c.id
    FROM public.ingestion_jobs c
    WHERE (
        (c.status IN ('queued','retrying') AND c.available_at <= clock_timestamp())
        -- reclaim jobs whose worker died mid-run
        OR (c.status = 'running' AND (c.locked_at IS NULL OR c.locked_at < clock_timestamp() - make_interval(secs => lock_seconds)))
      )
      AND c.attempt_count < c.max_attempts
      AND (only_user_id IS NULL OR c.user_id = only_user_id)
    ORDER BY c.available_at
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(capacity, GREATEST(LEAST(max_jobs, 5), 1))
  )
  RETURNING j.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_ingestion_jobs(text, text, integer, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ingestion_jobs(text, text, integer, integer, uuid) TO service_role;



CREATE OR REPLACE FUNCTION public.mutate_ingestion_claim(
  job_id uuid, claim_worker text, claim_attempt integer,
  document_patch jsonb DEFAULT '{}'::jsonb, chunk_rows jsonb DEFAULT '[]'::jsonb,
  job_patch jsonb DEFAULT '{}'::jsonb, prune_max_index integer DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j public.ingestion_jobs; d public.documents; patched public.documents; jp public.ingestion_jobs;
BEGIN
  SELECT * INTO j FROM public.ingestion_jobs WHERE id = job_id FOR UPDATE;
  IF NOT FOUND OR claim_worker IS NULL OR claim_attempt IS NULL OR j.locked_at IS NULL OR j.status <> 'running' OR j.locked_by IS DISTINCT FROM claim_worker
    OR j.attempt_count <> claim_attempt OR j.locked_at < clock_timestamp() - interval '300 seconds' THEN RETURN false; END IF;
  SELECT * INTO d FROM public.documents WHERE id = j.document_id AND user_id = j.user_id FOR UPDATE;
  IF NOT FOUND OR d.status = 'deleting' OR j.locked_at < clock_timestamp() - interval '300 seconds' THEN RETURN false; END IF;
  IF jsonb_array_length(chunk_rows) > 0 THEN
    IF EXISTS (SELECT 1 FROM jsonb_populate_recordset(NULL::public.document_chunks, chunk_rows) r
      WHERE r.document_id IS DISTINCT FROM j.document_id OR r.user_id IS DISTINCT FROM j.user_id) THEN RAISE EXCEPTION 'Invalid chunk owner'; END IF;
    INSERT INTO public.document_chunks (id, document_id, user_id, content, page_number, chunk_index, token_estimate, embedding, chunking_version, embedding_model)
      SELECT id, document_id, user_id, content, page_number, chunk_index, token_estimate, embedding, chunking_version, embedding_model
      FROM jsonb_populate_recordset(NULL::public.document_chunks, chunk_rows)
      ON CONFLICT (document_id, chunk_index) DO UPDATE SET id = EXCLUDED.id, content = EXCLUDED.content, embedding = EXCLUDED.embedding,
        page_number = EXCLUDED.page_number, token_estimate = EXCLUDED.token_estimate,
        chunking_version = EXCLUDED.chunking_version, embedding_model = EXCLUDED.embedding_model
        WHERE document_chunks.document_id = j.document_id AND document_chunks.user_id = j.user_id;
  END IF;
  IF prune_max_index IS NOT NULL THEN
    DELETE FROM public.document_chunks WHERE document_id = j.document_id
      AND (chunk_index > prune_max_index OR chunking_version <> (document_patch->>'chunking_version')::integer);
  END IF;
  IF job_patch->>'status' = 'succeeded' AND document_patch->>'status' IS DISTINCT FROM 'ready' THEN RAISE EXCEPTION 'Success requires atomic READY publication'; END IF;
  IF document_patch->>'status' = 'ready' AND (
    prune_max_index IS NULL OR (SELECT count(*) FROM public.document_chunks
      WHERE document_id = j.document_id AND user_id = j.user_id AND embedding IS NOT NULL
        AND chunking_version = (document_patch->>'chunking_version')::integer
        AND embedding_model = document_patch->>'embedding_model'
        AND vector_dims(embedding) = (document_patch->>'embedding_dimension')::integer
        AND chunk_index BETWEEN 0 AND prune_max_index) <> prune_max_index + 1
  ) THEN RAISE EXCEPTION 'Incomplete index cannot be published'; END IF;
  IF document_patch <> '{}'::jsonb THEN
    patched := jsonb_populate_record(d, document_patch);
    UPDATE public.documents SET status = patched.status, phase = patched.phase, progress = patched.progress,
      chunk_count = patched.chunk_count, page_count = patched.page_count, storage_path = patched.storage_path,
      byte_size = patched.byte_size, parser_version = patched.parser_version, chunking_version = patched.chunking_version,
      embedding_model = patched.embedding_model, embedding_dimension = patched.embedding_dimension,
      completed_at = patched.completed_at, failure_code = patched.failure_code,
      failure_message = patched.failure_message, error_message = patched.error_message WHERE id = d.id;
  END IF;
  IF job_patch <> '{}'::jsonb THEN
    jp := jsonb_populate_record(j, job_patch);
    UPDATE public.ingestion_jobs SET status = jp.status, available_at = jp.available_at,
      completed_at = jp.completed_at, locked_at = CASE WHEN jp.status = 'running' AND job_patch ? 'locked_at' THEN clock_timestamp() ELSE jp.locked_at END, locked_by = jp.locked_by,
      error_code = jp.error_code, error_message = jp.error_message WHERE id = j.id;
  END IF;
  RETURN true;
END; $$;
REVOKE ALL ON FUNCTION public.mutate_ingestion_claim(uuid,text,integer,jsonb,jsonb,jsonb,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mutate_ingestion_claim(uuid,text,integer,jsonb,jsonb,jsonb,integer) TO service_role;


-- Keep dense queries within the active embedding model space and published version.
CREATE OR REPLACE FUNCTION public.match_document_chunks_v2(
  query_embedding halfvec,
  requesting_user_id uuid,
  required_embedding_model text,
  match_count integer DEFAULT 6,
  document_ids uuid[] DEFAULT NULL,
  min_similarity double precision DEFAULT 0.25
)
RETURNS TABLE(
  id uuid,
  document_id uuid,
  filename text,
  content text,
  page_number integer,
  chunk_index integer,
  similarity double precision
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH eligible AS (
  SELECT c.id, c.document_id, d.filename, c.content, c.page_number, c.chunk_index,
         1 - (c.embedding <=> query_embedding) AS similarity
  FROM public.document_chunks c
  JOIN public.documents d ON d.id = c.document_id
  WHERE c.embedding IS NOT NULL
    AND requesting_user_id IS NOT NULL
    AND auth.uid() = requesting_user_id
    AND c.user_id = requesting_user_id
    AND d.user_id = requesting_user_id
    AND d.status = 'ready'
    AND (lower(d.filename) NOT LIKE '%.pptx' OR d.parser_version >= 2)
    AND c.chunking_version = d.chunking_version
    AND c.embedding_model = required_embedding_model
    AND d.embedding_model = required_embedding_model
    AND (document_ids IS NULL OR c.document_id = ANY(document_ids))
    AND (1 - (c.embedding <=> query_embedding)) >= min_similarity
  ), ranked AS (
    SELECT eligible.*, row_number() OVER (PARTITION BY document_id ORDER BY similarity DESC, id) AS doc_rank FROM eligible
  )
  SELECT id, document_id, filename, content, page_number, chunk_index, similarity
  FROM ranked WHERE doc_rank <= CASE WHEN (SELECT count(DISTINCT document_id) FROM eligible) > 1 THEN 8 ELSE 60 END
  ORDER BY similarity DESC, id
  LIMIT GREATEST(LEAST(match_count, 60), 1);
$$;

REVOKE ALL ON FUNCTION public.match_document_chunks_v2(halfvec, uuid, text, integer, uuid[], double precision) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.match_document_chunks_v2(halfvec, uuid, text, integer, uuid[], double precision) TO authenticated, service_role;


CREATE OR REPLACE FUNCTION public.lexical_document_chunks(
  query_text text,
  requesting_user_id uuid,
  match_count integer DEFAULT 20,
  document_ids uuid[] DEFAULT NULL::uuid[]
)
RETURNS TABLE(
  id uuid,
  document_id uuid,
  filename text,
  content text,
  page_number integer,
  chunk_index integer,
  lexical_rank double precision
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  WITH q AS (
    SELECT websearch_to_tsquery('english', coalesce(query_text, '')) AS tsq
  ), eligible AS (
  SELECT c.id, c.document_id, d.filename, c.content, c.page_number, c.chunk_index,
         ts_rank_cd(c.content_tsv, q.tsq)::double precision AS lexical_rank
  FROM public.document_chunks c
  JOIN public.documents d ON d.id = c.document_id
  CROSS JOIN q
  WHERE q.tsq IS NOT NULL
    AND numnode(q.tsq) > 0
    AND requesting_user_id IS NOT NULL
    AND auth.uid() = requesting_user_id
    AND c.user_id = requesting_user_id
    AND d.user_id = requesting_user_id
    AND d.status = 'ready'
    AND (lower(d.filename) NOT LIKE '%.pptx' OR d.parser_version >= 2)
    AND c.chunking_version = d.chunking_version
    AND (document_ids IS NULL OR c.document_id = ANY(document_ids))
    AND c.content_tsv @@ q.tsq
  ), ranked AS (
    SELECT eligible.*, row_number() OVER (PARTITION BY document_id ORDER BY lexical_rank DESC, id) AS doc_rank FROM eligible
  )
  SELECT id, document_id, filename, content, page_number, chunk_index, lexical_rank
  FROM ranked WHERE doc_rank <= CASE WHEN (SELECT count(DISTINCT document_id) FROM eligible) > 1 THEN 8 ELSE 60 END
  ORDER BY lexical_rank DESC, id
  LIMIT GREATEST(LEAST(match_count, 60), 1);
$function$;

REVOKE ALL ON FUNCTION public.lexical_document_chunks(text, uuid, integer, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lexical_document_chunks(text, uuid, integer, uuid[]) TO authenticated, service_role;
-- Browser uploads must correspond to an admitted, still-unenqueued reservation.
-- Signed upload tokens remain server-created, single-object, non-upsert tokens.
DROP POLICY IF EXISTS documents_insert_own ON storage.objects;
CREATE POLICY documents_insert_own ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'documents' AND (storage.foldername(name))[1] = auth.uid()::text AND EXISTS (
  SELECT 1 FROM public.documents d WHERE d.user_id = auth.uid() AND d.status = 'uploaded'
    AND name = d.user_id::text || '/' || d.id::text || '.' || lower(regexp_replace(d.filename, '^.*\.', ''))
    AND NOT EXISTS (SELECT 1 FROM public.ingestion_jobs j WHERE j.document_id = d.id AND j.status IN ('queued','running','retrying'))
));
DROP POLICY IF EXISTS documents_update_own ON storage.objects;
CREATE POLICY documents_update_own ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'documents' AND (storage.foldername(name))[1] = auth.uid()::text)
WITH CHECK (bucket_id = 'documents' AND (storage.foldername(name))[1] = auth.uid()::text AND EXISTS (
  SELECT 1 FROM public.documents d WHERE d.user_id = auth.uid() AND d.status = 'uploaded'
    AND name = d.user_id::text || '/' || d.id::text || '.' || lower(regexp_replace(d.filename, '^.*\.', ''))
    AND NOT EXISTS (SELECT 1 FROM public.ingestion_jobs j WHERE j.document_id = d.id AND j.status IN ('queued','running','retrying'))
));
REVOKE ALL ON FUNCTION public.enforce_upload_admission() FROM PUBLIC,anon,authenticated;

