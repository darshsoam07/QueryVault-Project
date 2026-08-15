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