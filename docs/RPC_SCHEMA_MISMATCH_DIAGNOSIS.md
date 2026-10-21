# Ingestion RPC schema mismatch: diagnosis and approval procedure

Date: 2026-10-21 (Asia/Calcutta). Verdict: **PARTIAL / production repair blocked pending hosted diagnostics and owner approval**.

## Confirmed evidence

For job bab9f365-9192-4d39-badc-b362b0e04fe8, the owner reports successful document/claim reads, a returned phase_write.validating request, RPC_SCHEMA_MISMATCH, the same error while recording failure, and claimed=1/succeeded=0/unconfirmed=1. This narrows the current incident to the mutation RPC boundary, rather than a missing worker, parser, embedding request or a hung initial read. It does not identify which original SQL/PostgREST code occurred because the old worker collapsed them.

Both phase transitions and failure persistence call the same mutate_ingestion_claim function. If it cannot resolve or execute, neither update can persist. unconfirmed=1 accurately reports that the failure was not stored; it must not be reported as failed=1 or successful recovery. The database can retain running/queued state, which explains the UI's old worker-started message until the lease expires or fresh state is available. No live row has been repaired here.

## Exact error mapping and instrumentation fix

Previously, mutateClaim checked error.code after workerStage returned. PGRST202, 42883 and 42703 each threw permanent(RPC_SCHEMA_MISMATCH, fixed safe message). The drain then called failJob through the same RPC; a second mismatch produced worker.failure_recording_deferred with original_error_code RPC_SCHEMA_MISMATCH and incremented unconfirmed. No successful failure write was inferred.

workerStage used to log completed whenever its promise resolved. Supabase resolves many HTTP/database failures as an object containing error, so that completed event was misleading. It now logs failed with the original allowlisted error_code and schema_error_kind before returning that response to the caller for normal classification or compatibility fallback. It does not print message, details, hint, payloads, private text, vectors or headers. Responses with data=false are rejected rather than completed. Actual thrown errors and timeouts still log failed. Successful responses still log completed.

The three original mappings remain. PGRST203 is additionally classified as permanent RPC_SCHEMA_MISMATCH, since ambiguous overload resolution is configuration failure, not a transient request to retry. Existing read compatibility fallbacks are preserved by returning error responses to their callers rather than throwing every Supabase error globally.

| Original code | Meaning / distinction                                                                                                                   | Evidence needed before repair                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| PGRST202      | PostgREST cannot resolve the cached function signature; missing function, wrong named arguments/defaults, or stale cache are candidates | All overloads, argument names/types/default counts, exposed schema/config and cache state                                 |
| PGRST203      | Ambiguous overload resolution                                                                                                           | Compare every overload, including JSON/JSONB and identical named arguments                                                |
| 42883         | PostgreSQL undefined function (also may describe an unresolved operator signature)                                                      | Determine whether the target or a dependency/trigger inside its body failed; inspect private server error context locally |
| 42703         | PostgreSQL undefined column                                                                                                             | Compare referenced table columns and the function/trigger body; the top-level RPC may exist with the correct signature    |
| 42501         | Permission denied, not mapped to schema mismatch                                                                                        | Role/schema/function grants and role inheritance; do not grant browser roles mutation access                              |

These distinctions follow [PostgREST's error reference](https://docs.postgrest.org/en/latest/references/errors.html) and [PostgreSQL 17 error codes](https://www.postgresql.org/docs/17/errcodes-appendix.html). They are categories, not a confirmed hosted root cause.

## Migration and TypeScript contract audit

Every repository migration referencing the ingestion objects was inventoried in [migration-inventory.json](rpc-schema-diagnosis/migration-inventory.json), including normalized function-body fingerprints. These are comparison aids, not proof of semantic equality or hosted deployment. A different hash warrants a private definition diff; it does not justify overwriting a function. Whitespace changes beyond CR normalization can change the hash.

| Migration      | Relevant contract                                                                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 20260814130517 | Base documents and document_chunks, ownership/RLS, halfvec(3072), counts/status/storage metadata                                                           |
| 20260814140015 | Integrity/version/model/dimension/failure columns and document transition trigger                                                                          |
| 20260814140933 | Generated content_tsv and lexical retrieval; no mutation RPC                                                                                               |
| 20260814141928 | phase/parser_version, chunk version/model, unique chunk identity, ingestion_jobs and first claim_ingestion_jobs                                            |
| 20260814145941 | Tightens browser mutation policies; no new RPC signature                                                                                                   |
| 20261008000000 | documents.content_type and format-aware Storage policies                                                                                                   |
| 20261015000000 | Global admission limits, replacement claim body, first mutate_ingestion_claim, reindex visibility trigger                                                  |
| 20261015010000 | Latest claim/mutation hardening: fixed lease, exhaustion, null/fresh-clock fencing, post-lock lease check, matching-model READY and success/READY coupling |

Other referencing migrations in the inventory concern retrieval, indexes, bucket provisioning or scheduler integration and do not add a competing mutation/claim definition. There are exactly three repository definitions of claim_ingestion_jobs and two of mutate_ingestion_claim. All claim definitions share one signature; both mutation definitions share one signature. No repository overload drift was found.

Expected signatures:

```sql
public.claim_ingestion_jobs(
  worker_id text,
  worker_version text DEFAULT '1',
  max_jobs integer DEFAULT 1,
  lock_seconds integer DEFAULT 300,
  only_user_id uuid DEFAULT NULL
) RETURNS SETOF public.ingestion_jobs;

public.mutate_ingestion_claim(
  job_id uuid, claim_worker text, claim_attempt integer,
  document_patch jsonb DEFAULT '{}'::jsonb,
  chunk_rows jsonb DEFAULT '[]'::jsonb,
  job_patch jsonb DEFAULT '{}'::jsonb,
  prune_max_index integer DEFAULT NULL
) RETURNS boolean;
```

The worker sends all required mutation keys plus document_patch, chunk_rows and job_patch; prune_max_index is omitted until needed, relying on its default. UUIDs/text are strings, integer arguments are numbers, and patches/rows are JSON objects/arrays. Generated TypeScript Args match the SQL names and optional defaults. Claiming sends worker_id, worker_version, max_jobs and lock_seconds=300, optionally only_user_id. No argument-name/type mismatch is confirmed in local source. Generated types cannot prove the hosted schema matches.

Latest normalized body fingerprints:

| Function               | Atomic-admission version         | Hardened version                 |
| ---------------------- | -------------------------------- | -------------------------------- |
| claim_ingestion_jobs   | 088fb8da8e857320d18a309bbfd13bc7 | ed9ce2462646e7f703c7c8908728a52b |
| mutate_ingestion_claim | ff4b9de00bca58471e68ab7bf8a32b0d | 93b4899cfcb6d12218ccd2ad5f92215a |

## Hosted read-only diagnostics: first required owner action

Use [ingestion_rpc_read_only_diagnostics.sql](sql/ingestion_rpc_read_only_diagnostics.sql) in an already authorized SQL console. The first block is a read-only transaction containing catalog SELECTs only; it invokes neither ingestion RPC. It returns all overloads, names/types/default counts, return types, security-definer/owner/search_path/body fingerprint, effective browser/service permissions, explicit ACLs, column types/RLS, policies/indexes/triggers, vector extension location and vector_dims signatures. It does not read jobs, documents, Vault secrets, function bodies or credentials.

Run the separate migration-ledger block only if the first block reports a readable supabase_migrations.schema_migrations. It selects version/name, deliberately excluding SQL statements. If the historical ledger lacks a name column, select version alone after inspecting its catalog columns; do not alter the ledger. Record inspection time and compare the output with the inventory and [expected referenced columns](sql/expected-ingestion-columns.json). Share sanitized metadata only.

If fingerprints differ, the owner should privately inspect pg_get_functiondef for the specific function and any failing trigger/dependency, removing secrets before sharing a minimal relevant diff. A correct signature does not guarantee a correct function body. A successful claim does not prove mutation exists: the legacy claim predates mutation by two months. Likewise, a ledger entry is not proof that manual DDL has not changed an object afterward.

**No hosted diagnostics have been executed in this task.** The owner has designated the current project as production. No production connection, SQL mutation, cache reload, drain or AI call was made. The actual hosted SQL difference is therefore still unknown, and no migration is approved for production.

## Smallest repair decision and review-only candidate

1. If the exact function, defaults, columns, body, ACL and exposure are correct but PGRST202 persists, investigate/reload the PostgREST schema cache under separate owner approval. The documented operation is NOTIFY pgrst, 'reload schema'; it is intentionally absent from the read-only diagnostics. Cache refresh cannot repair an absent function or column. See [PostgREST listener documentation](https://docs.postgrest.org/en/stable/references/listener.html).
2. If mutate_ingestion_claim is entirely absent and the hardened baseline otherwise matches, review [20261021000000_restore_missing_mutate_ingestion_claim.sql](sql/20261021000000_restore_missing_mutate_ingestion_claim.sql). It is deliberately outside supabase/migrations and is not picked up by automatic migration tooling.
3. If an existing function has a wrong signature/overload, stop and prepare an exact identity-specific forward migration after hosted inspection. Do not drop all overloads or replace an unknown function. CREATE OR REPLACE cannot silently rename input arguments or change return types safely; dependency/consumer review is required.
4. If a column or function/trigger dependency is missing, prepare only the evidence-specific additive/body repair after checking existing data, defaults, constraints and dependent consumers. No guessed ADD COLUMN or wholesale historical migration replay is included here.

The conditional candidate's exact SQL difference is **one new function only**, with the body copied verbatim from the latest hardened migration, service-role execution grants, browser/PUBLIC revocations, and one post-commit-delivered cache notification. It adds no tables/columns, changes no rows, alters no RLS policy, replaces no existing function and does not invoke a worker. It uses CREATE FUNCTION rather than CREATE OR REPLACE.

Its preflight refuses any existing public mutation overload, an unexpected hardened claim body/search_path/security mode, incompatible effective claim privileges, missing/wrongly typed referenced columns, disabled RLS, or missing valid unique chunk identity. Unexpected default execute grants also abort. Short lock/statement timeouts bound the transaction. Access-share table locks prevent concurrent destructive schema alteration during validation; they do not freeze ordinary document traffic. A concurrent function creation causes the transaction to fail rather than overwrite it. All changes roll back on a failed guard. It must be promoted to an approved forward migration only after actual hosted inspection confirms this exact absent-function case.

The candidate does not repair an older claim/admission baseline. That is deliberate: preserving concurrency and retry/lease hardening requires reviewing those missing prerequisites together instead of blindly adding a mutation function.

## Isolated validation

| Check                                            | Actual result                                     |
| ------------------------------------------------ | ------------------------------------------------- |
| Targeted concurrent worker regressions           | 25 passed                                         |
| npm run typecheck                                | Passed                                            |
| npm run lint                                     | 0 errors, 14 existing warnings                    |
| npm test -- --configLoader native --maxWorkers 1 | 592 passed, 2 skipped; 35 files passed, 1 skipped |
| npm run build                                    | Passed                                            |
| npm run security:client                          | Passed; no client-secret violations               |
| npm run test:db                                  | 17 isolated PostgreSQL/pgvector checks passed     |

The two skips are opt-in live provider/verifier tests in provider-live.test.ts and gemini-provider.test.ts. Playwright, standalone RAG evaluation, hosted/PostgREST cache acceptance, real Auth/Storage HTTP and live ingestion were not run in this task. No skipped check is counted as passed. The disposable container and its anonymous volume were removed. See [results](rpc-schema-diagnosis/results.json) and [database evidence](rpc-schema-diagnosis/local-database.json).

The database runner only accepts a disposable queryvault-phase2-* Docker container with network none and no host mounts. It never reads .env or accepts a hosted URL. It uses the already cached pgvector image with --pull=never. Auth/Storage schemas are scaffolding; actual Auth/Storage HTTP and cron/net/Vault are not validated.

New checks cover candidate refusal of existing/wrong overloads and missing columns; restoring only an absent function; unchanged claim body; service-role-only access; preserved RLS; executable read-only diagnostics; actual PostgreSQL 42883/42703 reproduction; and the observed phase-write/failure-recording errors for all four classified codes. Existing tests still cover lease replacement/expiry, capacity, stale writes, retries/exhaustion, complete READY, duplicate publication and tenant-scoped retrieval. No assertions were weakened.

## Rollout and rollback procedure: approval remains required

1. Owner runs the read-only catalog and ledger diagnostics; retain sanitized output. Identify the original error code from the patched worker's stage logs in the next separately authorized run, without starting a hosted drain here.
2. Compare actual SQL metadata/body privately. Select the smallest applicable branch above. If the candidate does not match, do not execute it; produce a new explicit diff. Review dependencies, function ownership, role inheritance and the complete local change set.
3. Obtain owner approval for that exact reviewed SQL artifact and deployment target. Schedule any worker pause/release through the existing supervised process; no job resets or attempt rewrites. Capture the previous function definition/ACLs privately for rollback, and record the intended forward migration version through the project's approved migration procedure.
4. Apply only the individually approved migration or approved cache refresh, transactionally. Do not use a database reset or blanket db push. Re-run read-only catalog/ACL/RLS checks and compare identities/defaults/body hashes. A returned notification is not proof the cache refreshed; inspect the intended PostgREST instance's cache/logs or an explicitly authorized non-mutating check.
5. Do not use the worker mutation RPC as a harmless health probe: it can change real data. Validate complete ingestion only after a separately approved isolated acceptance path/provider budget. No external AI request is authorized by this report. Recovery of existing production jobs must follow the ordinary fenced claim/attempt rules and separate owner authorization.
6. If application instrumentation needs rollback, restore the previous reviewed application artifact without changing database rows. If the newly added function needs rollback, first stop new mutations through an approved maintenance procedure; prefer a reviewed forward corrective migration. Do not automatically drop it while other workers depend on it. Preserve leases, RLS, budgets and atomic READY. Never rewrite the migration ledger to hide an application mistake.

Remaining blockers: original provider/SQL code and hosted metadata; exact approved repair branch; owner migration approval; PostgREST cache/exposure confirmation; real isolated HTTP acceptance and separately authorized provider-backed ingestion. **Local tests are not evidence of live production recovery.** No push, deployment, hosted mutation, billing/model change or new AI request occurred.
