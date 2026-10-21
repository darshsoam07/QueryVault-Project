# Missing ingestion RPC: reviewed local repair

Date: 2026-10-22 (Asia/Calcutta). **Local repair prepared; production application requires explicit approval.**

## Confirmed diagnosis and compatibility

The owner confirms production has claim_ingestion_jobs, lacks mutate_ingestion_claim, and has all 13 columns checked during their inspection. The missing mutation function explains the first phase failure and the second failure when attempting to record that failure. Both use the missing RPC. Successful claiming does not establish mutation availability. The worker correctly leaves persistence unconfirmed rather than inventing failure or READY.

This is owner-supplied production evidence. No production query, worker invocation or SQL change was made here. Presence/type checks for all referenced columns, actual claim body/security settings, unique chunk identity, schema CREATE privileges and role inheritance remain production prerequisites beyond those 13 reported checks. The migration intentionally aborts on any unmet prerequisite instead of changing unrelated schema.

## Exact migration

[20261022000000_restore_ingestion_claim_rpc.sql](../supabase/migrations/20261022000000_restore_ingestion_claim_rpc.sql) is the new timestamped forward migration. It supersedes the earlier review-only absent-function candidate in docs/sql; **do not apply both**. Earlier diagnosis reports remain historical and do not describe this migration's verified no-op behavior.

The only persistent change on the missing-function branch is creation of:

```sql
public.mutate_ingestion_claim(
 job_id uuid, claim_worker text, claim_attempt integer,
 document_patch jsonb DEFAULT '{}'::jsonb,
 chunk_rows jsonb DEFAULT '[]'::jsonb,
 job_patch jsonb DEFAULT '{}'::jsonb,
 prune_max_index integer DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp;
```

The body is identical to the hardened 20261015010000 definition (normalized body MD5 93b4899cfcb6d12218ccd2ad5f92215a). The search path is the sole function-definition difference on creation. Built-ins resolve through pg_catalog first; all table and row-type references are public-qualified; pg_temp is explicitly last. The migration rejects untrusted schema CREATE privileges. It revokes execute from PUBLIC/anon/authenticated, grants service_role, and rejects unexpected default execute grants. The administrative function owner and superusers retain PostgreSQL's inherent control; 'service-role-only' describes application access, not removal of owner/superuser privileges.

It never uses CREATE OR REPLACE. If exactly one existing hardened function already matches names, types, defaults, scalar return, body, security mode and privileges, its OID/body/ACL remain unchanged. The original hardened public-only search path and the new explicit path are recognized for this no-op. Other overloads or drift abort. No rows, job identifiers, statuses, attempts, documents, vectors, RLS policies, claim functions or table columns are changed. A transactional NOTIFY requests cache refresh after commit; it is not evidence of successful PostgREST reload.

## Prerequisites and migration history

Run the [read-only catalog diagnostics](sql/ingestion_rpc_read_only_diagnostics.sql) in the owner's approved console. Verify:

1. Correct production project and migration ledger; mutation is absent, or its exact canonical contract already matches. Inspect all overloads.
2. The hardened claim function identity public.claim_ingestion_jobs(text,text,integer,integer,uuid), expected defaults/security/search_path and normalized body MD5 ed9ce2462646e7f703c7c8908728a52b. The guard deliberately refuses a different baseline. A merely present legacy claim is insufficient: missing global admission or exhaustion hardening needs separate review, not silent replay.
3. All [referenced column types](sql/expected-ingestion-columns.json), not only column names; valid unique (document_id,chunk_index) index; RLS enabled on the three ingestion tables.
4. pgvector halfvec(3072) and its public vector_dims dependency resolve under the function search path. The isolated image uses public-installed pgvector. An extension placed elsewhere requires compatibility review; do not move it automatically.
5. service_role can execute the claim function; PUBLIC/anon/authenticated cannot. Review custom role membership/default privileges and trusted administrative ownership. public schema CREATE must be restricted to trusted owner/executor/service role; the migration aborts on other direct CREATE grants or browser-role effective CREATE.
6. Ledger versions for the lifecycle/queue migrations, 20261015000000 and 20261015010000, match actual objects. If a historical version is absent or partially represented, stop and reconcile through the project's approved migration process. Do not manually insert ledger rows or replay the old broad migrations.

The owner can additionally inspect schema CREATE grants without changing anything:

```sql
SELECT n.nspname,
       CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
       a.privilege_type
FROM pg_namespace n
CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a
WHERE n.nspname='public' AND a.privilege_type='CREATE';
SELECT has_schema_privilege('anon','public','CREATE') AS anon_create,
       has_schema_privilege('authenticated','public','CREATE') AS authenticated_create;
```

Trusted search paths and revoking default PUBLIC execution within the creation transaction follow [PostgreSQL's SECURITY DEFINER guidance](https://www.postgresql.org/docs/current/sql-createfunction.html#SQL-CREATEFUNCTION-SECURITY).

The migration uses a 3-second lock timeout, 30-second statement timeout and access-share table locks to prevent concurrent destructive DDL during checks. Ordinary writes are not blocked by those locks. Creation/permissions/guards execute in one transaction, so default PUBLIC privileges are not exposed at commit. Any error rolls everything back. It contains no ingestion RPC invocation.

## Preserved reliability boundaries

The function locks the job and document, checks worker/attempt/running state and non-null unexpired 300-second lease, then checks expiry again after obtaining the document lock. It refuses stale owners before chunk or state writes. Chunk rows must match document and user ownership; version writes remain idempotent on unique chunk identity. Chunk insertion, pruning, document state and job state updates remain one transaction.

READY still requires a complete index with matching owner, model, chunking version, embedding dimension and index range; succeeded requires simultaneous READY. RLS is not disabled. SECURITY DEFINER allows the trusted service role to perform fenced writes without granting browser mutations. Claim ceilings, attempt budgets and retry backoff are unchanged. Failure recording uses the same ownership fence.

## Local verification

| Check                                | Actual result                                     |
| ------------------------------------ | ------------------------------------------------- |
| Disposable PostgreSQL/pgvector suite | 20 checks passed                                  |
| Existing unit/worker suite           | 592 passed, 2 skipped; 35 files passed, 1 skipped |
| TypeScript                           | Passed                                            |
| Lint                                 | 0 errors, 14 existing warnings                    |
| Production build                     | Passed                                            |
| Client secret scan                   | No violations                                     |

The two skipped tests are opt-in live provider/verifier tests. Playwright, standalone RAG evaluation, hosted PostgREST/cache acceptance, real Supabase Auth/Storage HTTP and live ingestion were not run. No skipped result is counted as passed. A second database launch initially could not open a log still held by the preceding run; it was rerun sequentially and the final 20-check run passed. No assertion was weakened or removed. Evidence is in [results.json](ingestion-rpc-repair/results.json) and [local-database.json](ingestion-rpc-repair/local-database.json).

Tests use only cached, disposable network-none PostgreSQL/pgvector with no host mounts. No hosted credentials or .env are read by the database runner. Auth/Storage schemas are scaffolding; HTTP services and PostgREST are not running in this fixture.

Coverage: fresh full migration chain; missing-function restoration; exact names/types/defaults and safe search_path; no-op OID/ACL preservation; refusal of wrong overloads, missing columns and untrusted schema CREATE; service-role execution with anon/authenticated denial; validation transition; atomic failure recording; expired leases; reclaim/stale writes; atomic/idempotent chunk writes; complete READY safeguards and duplicate publication rejection. Existing worker tests run with mocked providers; they do not demonstrate real Gemini or production indexing.

## Risk analysis

The main risk is an incompletely inspected hosted baseline. Guards are deliberately conservative; a failed guard is a blocker for review, not permission to remove it. Existing workers or a scheduler may begin mutating jobs as soon as the RPC becomes available, even though the migration itself changes no data. The owner must decide an approved maintenance/supervision plan before application. No process was stopped or started here.

The approved executor must be a trusted database administrator. The function intentionally bypasses browser RLS through SECURITY DEFINER while enforcing service-only access and ownership/lease checks internally. Compromised service credentials remain privileged; no credentials are exposed by this patch. Cache delivery/visibility and hosted pgvector location are external dependencies. SQL success does not establish live AI availability or READY acceptance.

## Production deployment instructions (not executed)

1. Review this exact migration and prerequisite output, project identity, migration order and SHA-256. Obtain explicit owner approval for this SQL artifact and target. Retain the pre-application function absence/existing-definition snapshot and ledger state.
2. Establish an approved worker/scheduler maintenance plan to avoid unintended recovery when the function appears. Do not delete, requeue or reset attempts. Do not invoke a hosted drain as a probe.
3. Use the project's approved migration runner configured to execute **only 20261022000000_restore_ingestion_claim_rpc.sql**, with automatic ledger accounting. The actual hosted runner has not been inspected. If the tool would apply other pending files, stop for review. Do not use a reset, blanket db push, manual ledger modification or ad-hoc broad migration replay. No installation/download is authorized by this document.
4. The runner must respect this file's transaction boundaries. On guard/timeout failure, confirm rollback and inspect the named prerequisite; do not retry indefinitely or weaken guards. Verify the approved artifact hash before any retry.
5. Run [verify_restored_ingestion_claim_rpc.sql](sql/verify_restored_ingestion_claim_rpc.sql), which is read-only and never invokes ingestion. Expected on restoration: exactly one overload, true interface/body/security checks, new search_path, service_execute=true, anon_execute=false, authenticated_execute=false, no_extra_execute_grants=true, and RLS true. Re-run the wider catalog/ledger diagnostics for comparison.
6. Confirm the intended PostgREST instance processed schema refresh. The notification alone is not proof. Do not invoke the mutation RPC against production for verification. Owner approval for this migration does not authorize worker recovery, external AI or new ingestion; those require separate scope/approval. Only then consider resuming an approved execution path and observing ordinary fenced recovery.

## Rollback procedure

Before commit, any SQL failure rolls back function creation and grants. After commit, prefer a separately reviewed forward correction. Removing the RPC reinstates the known outage and may interrupt active ingestion, so do not drop it automatically.

If removal is explicitly approved: verify the pre-application snapshot proves the RPC was missing (never remove a function that was preserved by the no-op branch), stop new mutations through an approved maintenance process, verify the current body/OID/ACL have not drifted, and use a new tracked forward migration to DROP FUNCTION public.mutate_ingestion_claim(uuid,text,integer,jsonb,jsonb,jsonb,integer) without CASCADE, followed by an approved cache notification. Dependency failures must stop the rollback. Do not mutate rows, reset jobs, rewrite prior migrations or edit hosted migration history manually. Preserve all unrelated schema/data. No rollback SQL has been run or automatically scheduled.

## Readiness verdict

**Ready for human review of the local repair; production application pending explicit approval and complete prerequisite verification.** The owner-confirmed missing function is the root cause. Successful isolated restoration meets the local success criterion; it does not establish production recovery, PostgREST cache readiness, live embeddings or end-to-end ingestion. No production SQL, recovery, push, deployment, new AI request, model/billing change or download occurred.
