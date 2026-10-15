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
