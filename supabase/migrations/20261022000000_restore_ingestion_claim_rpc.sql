-- Forward-only restoration of the missing fenced ingestion mutation RPC.
-- Production application requires explicit owner approval and preflight review.
-- Creates no rows and never overwrites an existing function. Exact matching
-- hardened definitions are a verified no-op; any drift or overload aborts.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public.documents, public.ingestion_jobs, public.document_chunks IN ACCESS SHARE MODE;
DO $repair$
DECLARE missing text;
BEGIN
  IF has_schema_privilege('anon','public','CREATE') OR has_schema_privilege('authenticated','public','CREATE')
    OR EXISTS (SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname='public' AND a.grantee NOT IN (n.nspowner,current_user::regrole::oid,'service_role'::regrole::oid) AND a.privilege_type='CREATE') THEN
    RAISE EXCEPTION 'Review required: untrusted CREATE privileges on public schema';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='mutate_ingestion_claim') THEN
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='mutate_ingestion_claim') <> 1 OR NOT EXISTS (
      SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.mutate_ingestion_claim(uuid,text,integer,jsonb,jsonb,jsonb,integer)')
      AND md5(replace(p.prosrc,chr(13),''))='93b4899cfcb6d12218ccd2ad5f92215a'
      AND p.proargnames=ARRAY['job_id','claim_worker','claim_attempt','document_patch','chunk_rows','job_patch','prune_max_index']
      AND p.pronargdefaults=4 AND pg_get_expr(p.proargdefaults,0)=$defaults$'{}'::jsonb, '[]'::jsonb, '{}'::jsonb, NULL::integer$defaults$
      AND p.prorettype='boolean'::regtype AND NOT p.proretset AND p.prosecdef
      AND p.proconfig IN (ARRAY['search_path=public'],ARRAY['search_path=pg_catalog, public, pg_temp'])
      AND has_function_privilege('service_role',p.oid,'EXECUTE')
      AND NOT has_function_privilege('anon',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE')
      AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.privilege_type='EXECUTE' AND a.grantee NOT IN (p.proowner,'service_role'::regrole::oid))
    ) THEN RAISE EXCEPTION 'Review required: existing mutation function differs or has overloads'; END IF;
    RETURN; -- Matching existing contract is never silently replaced or altered.
  END IF;
  IF NOT has_function_privilege('service_role','public.claim_ingestion_jobs(text,text,integer,integer,uuid)','EXECUTE')
    OR has_function_privilege('anon','public.claim_ingestion_jobs(text,text,integer,integer,uuid)','EXECUTE')
    OR has_function_privilege('authenticated','public.claim_ingestion_jobs(text,text,integer,integer,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'Review required: claim RPC privileges differ';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.claim_ingestion_jobs(text,text,integer,integer,uuid)')
    AND md5(replace(prosrc,chr(13),''))='ed9ce2462646e7f703c7c8908728a52b' AND prosecdef AND proconfig=ARRAY['search_path=public']) THEN
    RAISE EXCEPTION 'Review required: hardened claim baseline differs';
  END IF;
  SELECT string_agg(e.t||'.'||e.c, ', ') INTO missing FROM (VALUES
    ('documents','id','uuid'),
    ('documents','user_id','uuid'),
    ('documents','status','text'),
    ('documents','phase','text'),
    ('documents','progress','integer'),
    ('documents','chunk_count','integer'),
    ('documents','page_count','integer'),
    ('documents','storage_path','text'),
    ('documents','byte_size','bigint'),
    ('documents','parser_version','integer'),
    ('documents','chunking_version','integer'),
    ('documents','embedding_model','text'),
    ('documents','embedding_dimension','integer'),
    ('documents','completed_at','timestamp with time zone'),
    ('documents','failure_code','text'),
    ('documents','failure_message','text'),
    ('documents','error_message','text'),
    ('ingestion_jobs','id','uuid'),
    ('ingestion_jobs','document_id','uuid'),
    ('ingestion_jobs','user_id','uuid'),
    ('ingestion_jobs','status','text'),
    ('ingestion_jobs','attempt_count','integer'),
    ('ingestion_jobs','max_attempts','integer'),
    ('ingestion_jobs','locked_at','timestamp with time zone'),
    ('ingestion_jobs','locked_by','text'),
    ('ingestion_jobs','available_at','timestamp with time zone'),
    ('ingestion_jobs','completed_at','timestamp with time zone'),
    ('ingestion_jobs','error_code','text'),
    ('ingestion_jobs','error_message','text'),
    ('document_chunks','id','uuid'),
    ('document_chunks','document_id','uuid'),
    ('document_chunks','user_id','uuid'),
    ('document_chunks','content','text'),
    ('document_chunks','page_number','integer'),
    ('document_chunks','chunk_index','integer'),
    ('document_chunks','token_estimate','integer'),
    ('document_chunks','embedding','halfvec(3072)'),
    ('document_chunks','chunking_version','integer'),
    ('document_chunks','embedding_model','text')
  ) e(t,c,typ) LEFT JOIN pg_attribute a ON a.attrelid=to_regclass('public.'||e.t) AND a.attname=e.c AND a.attnum>0 AND NOT a.attisdropped
    WHERE a.attname IS NULL OR format_type(a.atttypid,a.atttypmod)<>e.typ;
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'Review required: incompatible columns: %',missing; END IF;
  IF to_regprocedure('public.vector_dims(public.halfvec)') IS NULL THEN
    RAISE EXCEPTION 'Review required: public pgvector dependency is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE oid IN ('public.documents'::regclass,'public.ingestion_jobs'::regclass,'public.document_chunks'::regclass) AND NOT relrowsecurity) THEN
    RAISE EXCEPTION 'Review required: RLS is disabled';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid='public.document_chunks'::regclass AND i.indisunique AND i.indisvalid AND i.indpred IS NULL
    AND (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(i.indkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.num)=ARRAY['document_id','chunk_index']) THEN
    RAISE EXCEPTION 'Review required: chunk identity constraint differs';
  END IF;
EXECUTE $definition$
CREATE FUNCTION public.mutate_ingestion_claim(
  job_id uuid, claim_worker text, claim_attempt integer,
  document_patch jsonb DEFAULT '{}'::jsonb, chunk_rows jsonb DEFAULT '[]'::jsonb,
  job_patch jsonb DEFAULT '{}'::jsonb, prune_max_index integer DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
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
$definition$;
REVOKE ALL ON FUNCTION public.mutate_ingestion_claim(uuid,text,integer,jsonb,jsonb,jsonb,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mutate_ingestion_claim(uuid,text,integer,jsonb,jsonb,jsonb,integer) TO service_role;
  IF EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid='public.mutate_ingestion_claim(uuid,text,integer,jsonb,jsonb,jsonb,integer)'::regprocedure
      AND a.privilege_type='EXECUTE' AND a.grantee NOT IN (p.proowner,'service_role'::regrole::oid)) THEN
    RAISE EXCEPTION 'Review required: unexpected default RPC privileges';
  END IF;
END $repair$;
NOTIFY pgrst, 'reload schema';
COMMIT;
