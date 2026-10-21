-- READ ONLY. Does not invoke ingestion, change jobs, or refresh schema cache.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '10s';
WITH target AS (SELECT to_regprocedure('public.mutate_ingestion_claim(uuid,text,integer,jsonb,jsonb,jsonb,integer)') AS oid)
SELECT p.oid IS NOT NULL AS function_present,
 p.proargnames=ARRAY['job_id','claim_worker','claim_attempt','document_patch','chunk_rows','job_patch','prune_max_index'] AS argument_names_match,
 p.pronargdefaults=4 AS four_defaults,
 pg_get_expr(p.proargdefaults,0)=$d$'{}'::jsonb, '[]'::jsonb, '{}'::jsonb, NULL::integer$d$ AS defaults_match,
 p.prorettype='boolean'::regtype AND NOT p.proretset AS scalar_boolean,
 p.prosecdef AS security_definer,
 p.proconfig AS search_path,
 md5(replace(p.prosrc,chr(13),''))='93b4899cfcb6d12218ccd2ad5f92215a' AS hardened_body_matches,
 pg_get_userbyid(p.proowner) AS owner,
 has_function_privilege('service_role',p.oid,'EXECUTE') AS service_execute,
 has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,
 has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_execute,
 NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   WHERE a.privilege_type='EXECUTE' AND a.grantee NOT IN(p.proowner,'service_role'::regrole::oid)) AS no_extra_execute_grants
FROM target LEFT JOIN pg_proc p ON p.oid=target.oid;
SELECT c.relname,c.relrowsecurity FROM pg_class c WHERE c.oid IN
 ('public.documents'::regclass,'public.ingestion_jobs'::regclass,'public.document_chunks'::regclass);
SELECT p.oid::regprocedure::text AS identity FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname='mutate_ingestion_claim';
COMMIT;
