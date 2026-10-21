-- READ ONLY: no function invocation, cache refresh, DDL or job mutation.
-- Run in the owner's authorized SQL console. Share metadata only.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '10s';
SELECT clock_timestamp() AS observed_at, current_user AS inspecting_role,
       current_setting('server_version') AS postgres_version;

-- Every overload, names/types/default count and return type. No function bodies.
SELECT n.nspname AS schema_name,p.proname,p.oid::regprocedure::text AS identity,
       pg_get_function_identity_arguments(p.oid) AS identity_arguments,
       p.proargnames,oidvectortypes(p.proargtypes) AS input_types,p.pronargdefaults AS default_count,
       pg_get_function_result(p.oid) AS result_type,p.prosecdef AS security_definer,
       pg_get_userbyid(p.proowner) AS owner,
       (SELECT x FROM unnest(p.proconfig) x WHERE x LIKE 'search_path=%' LIMIT 1) AS search_path,
       md5(replace(p.prosrc,chr(13),'')) AS normalized_body_md5,
       has_function_privilege(to_regrole('service_role'),p.oid,'EXECUTE') AS service_execute,
       has_function_privilege(to_regrole('authenticated'),p.oid,'EXECUTE') AS authenticated_execute,
       has_function_privilege(to_regrole('anon'),p.oid,'EXECUTE') AS anon_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname IN ('mutate_ingestion_claim','claim_ingestion_jobs')
ORDER BY p.proname,p.oid::regprocedure::text;

SELECT p.oid::regprocedure::text AS function_identity,
       CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
       a.privilege_type,a.is_grantable
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
WHERE n.nspname='public' AND p.proname IN ('mutate_ingestion_claim','claim_ingestion_jobs')
ORDER BY 1,2;

SELECT c.relname,a.attname,format_type(a.atttypid,a.atttypmod) AS type_name,a.attnotnull,
       a.attgenerated,c.relrowsecurity,c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
WHERE n.nspname='public' AND c.relname IN ('documents','ingestion_jobs','document_chunks','ingestion_limits')
ORDER BY c.relname,a.attnum;
SELECT tablename,policyname,roles,cmd,permissive,md5(coalesce(qual,'')) AS using_hash,
       md5(coalesce(with_check,'')) AS check_hash
FROM pg_policies WHERE schemaname='public'
AND tablename IN ('documents','ingestion_jobs','document_chunks','ingestion_limits') ORDER BY 1,2;
SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public'
AND tablename IN ('documents','ingestion_jobs','document_chunks','ingestion_limits') ORDER BY 1,2;
SELECT c.relname,t.tgname,t.tgenabled,t.tgfoid::regprocedure::text AS function_identity
FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE NOT t.tgisinternal AND n.nspname='public'
AND c.relname IN ('documents','ingestion_jobs','document_chunks') ORDER BY 1,2;
SELECT to_regclass('supabase_migrations.schema_migrations') AS migration_ledger;
SELECT e.extname,e.extversion,n.nspname AS extension_schema FROM pg_extension e
JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector';
SELECT n.nspname,p.oid::regprocedure::text AS identity FROM pg_proc p
JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.proname='vector_dims';
COMMIT;

-- Run this separate block ONLY if migration_ledger above is present and readable.
-- Deliberately excludes the statements column (SQL may contain sensitive values).
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '10s';
SELECT version,name FROM supabase_migrations.schema_migrations ORDER BY version;
COMMIT;
