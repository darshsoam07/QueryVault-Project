# QueryVault Phase 2 production audit

Current verdict: see [Phase 4 live acceptance](PHASE4_ACCEPTANCE.md), which records fresh 503 evidence, local regressions and explicit restrictions on hosted resources.

Latest continuation: [Gemini verifier hardening and current results](GEMINI_VERIFIER_HARDENING.md). The original audit results below are historical; the continuation has 537 passing unit tests and a separately executed live verifier failure (two deadline timeouts). Use the [isolated Supabase acceptance checklist](ISOLATED_SUPABASE_ACCEPTANCE.md) before production approval.

Audited 15 October 2026 in the existing working tree, preserving the Phase 1 changes. No push or hosted deployment was performed. **Production readiness is not complete:** the real Gemini support-verifier fixture returned HTTP 503, and full isolated Supabase HTTP/scheduler acceptance remains outstanding.

## A. Architecture audit

The active application is the root React/TypeScript TanStack Start app. Supabase Auth supplies identity, private Storage retains originals, Postgres owns document state and durable ingestion jobs, and pgvector plus full-text search supply evidence. There is no separate collection entity: the current collection is the owner's vault, optionally restricted by explicit document IDs. The separate local-stack app was not modified.

Browser files are hashed and reserved server-side, uploaded with at most three transport slots, and enqueued durably. Workers claim a shared Postgres queue; fenced RPC writes check worker/attempt/lease/document state. The application buffers complete answers before citation/support validation and only then emits and persists an identical delivery plan. The offline retrieval evaluation previously simulated citation validity; a new independent safety gate now exercises real runtime deterministic contracts.

## B. Problems discovered, by severity

| Severity | Finding | Disposition |
| --- | --- | --- |
| Critical | Registry-backed dependency audit initially reported two critical advisories, including serialization/shell dependencies. A restricted-network audit incorrectly appeared clean. | Compatible security updates applied; final registry audit has zero critical/high findings. |
| High | Reindexing could move existing READY documents into active processing without upload-admission checks. | Admission trigger now covers relevant status/size updates; real Postgres test passed. |
| High | Lease checks used transaction-start time, allowed null lock timestamps, and did not recheck expiry after waiting for a document lock. | Database wall clock, null checks and post-lock recheck added; real lock-wait regression passed. |
| High | Dense retrieval did not enforce the active embedding model space or published chunk version. | New model-bound v2 RPC and published-version filtering; real SQL retrieval checks passed. |
| High | Raw provider error bodies/messages could leak echoed document content. Diagnostic traces also retained private previews by default. | Error logs reduced to safe metadata; trace content now opt-in. Client secret scan passed. |
| High | SheetJS 0.18.5 had known parsing advisories; Office decompression and PDF extraction needed stronger resource guards. | Same library upgraded to official 0.20.3; ZIP limits, signatures, PDF page/aggregate limits and cleanup added. |
| High / release blocker | Live Gemini support-verifier requests returned HTTP 503 for both supported and fabricated synthetic fixtures. | Fails closed; no model/provider switch or validation weakening. Successful answer-provider verification still required. |
| Medium | PPTX filename order can differ from displayed slide order. | Parser follows presentation relationships; parser version 2 and retrieval/UI reindex guards protect older files. |
| Medium | Default upload rate was 12 while the UI offered 20-file batches. | Default is now 20 per five minutes; existing explicit lower environment overrides remain operator choices. |
| Medium | Stalled embeddings/utility calls could occupy workers indefinitely; queued cancellation waited for a slot; custom rewrite abort reasons could degrade into fallback. | Real deadlines, immediate queued removal, synchronous-error slot cleanup, cancellation propagation and regression tests added. |
| Medium | Direct Storage policies allowed owner-prefixed objects without a matching reservation or after enqueue. | Browser writes now require an admitted uploaded document and no live job; real policy tests passed. |
| Medium | Crashed jobs could be reclaimed beyond their attempt budget; missing settings could weaken admission. | Terminal recovery outcomes and fail-closed settings checks added and tested in Postgres. |
| Medium | Few retrieved passages could be presented as a comprehensive summary; omitted numeric disagreements were not checked locally. | Excerpt summary notice, rejection of unsupported completeness claims, narrow local conflict answers citing both statements. |
| Low | MIME/extension mismatch, binary text, invalid batch settings, inaccessible upload activation, and misleading non-PDF page labels. | Validation, configuration fallback, keyboard/selection/progress labels, resume action and authentic locator labels improved. |

## C. Changes implemented

- `supabase/migrations/20261015010000_production_hardening.sql`: forward migration covering admission updates, wall-clock fencing, exhausted recovery, atomic publication metadata checks, model/version retrieval and reservation-bound Storage policies.
- `supabase/bootstrap.sql`, `src/integrations/supabase/types.ts`: generated bootstrap and v2 retrieval contract maintained.
- `src/lib/ai-gateway.server.ts`, `src/lib/ai-options.server.ts`: HTTP deadlines, cancellation, safe errors, integer concurrency configuration and model-specific Gemini thinking options. Gemini 3/4 use levels; 2.5 retains its supported budget. The verifier's 256-token cap is unchanged, truncated verdicts are rejected, nested provider retries are disabled, and status/usage diagnostics contain no answer text.
- `src/lib/ingestion/{worker.server,document-parser.server,archive-policy.server}.ts`: database-authoritative leases, bounded Office expansion, UTF-8/signature checks, PDF page/aggregate bounds and loading-task cleanup. PPTX locators now follow presentation relationship order instead of filenames; parser version 2 forces older presentations to reindex before retrieval.
- `src/lib/retrieval/{dense,pipeline,query-rewrite,claim-evidence,conflicts,support-verifier.server}.ts`, `src/routes/api/chat.ts`: active embedding model filtering, request cancellation, deterministic quotation/format checks, local conflicts, coverage-aware summaries and safe validation telemetry.
- `src/lib/upload-queue.ts`, `src/lib/upload-batch-policy.ts`, `src/lib/ingest.ts`, `src/components/queryvault/KnowledgePanel.tsx`: immediate queued cancellation, transport timeout, validated limits, keyboard controls and recovery labels.
- `src/lib/observability/{telemetry.server,trace-privacy}.ts`: private diagnostic content disabled by default while IDs/scores/timings remain useful.
- `package.json`, `package-lock.json`, `bun.lock`: patched dependencies and commands for real local database tests, answer-safety evaluation, fixture benchmarks and client-secret scanning. Bun lock was regenerated from the canonical npm lock.
- New/extended Vitest tests, mocked browser tests, and `scripts/{test-database.mjs,benchmark-ingestion.ts,check-client-secrets.mjs}` provide repeatable checks without hosted database writes.

## D. Database status and migration safety

Both 20261015 migrations were applied and tested on a disposable **real PostgreSQL/pgvector** container, network mode `none`, no published ports and no host bind mounts. Auth/Storage schemas and roles were test scaffolding; this is not a complete Supabase deployment. The cron/net/Vault scheduler migration and actual Auth/Storage HTTP services were not verified. Test databases were dropped after each run. See [database evidence](phase2/database.json).

Thirteen checks cover simultaneous admission, 20 reservations, owner duplicate constraints, overlapping global claims, expired/null leases, idempotent version replacement, complete publication, dense/lexical model/version/scope restrictions, reindex admission, RLS/service-role access, reservation-bound Storage writes, expiry while blocked on a row lock, exhausted crash recovery and deletion.

### Prerequisites and service impact

1. Back up Postgres and private Storage using the environment's managed backup/export facilities; test restoration to an isolated project. Backups contain private data and require encryption and restricted access.
2. Stop old workers and scheduler wakeups before migrating. Old Phase 0 workers do not use fenced writes and must not run alongside the new code.
3. Apply the existing migrations in filename order, then `20261015000000_atomic_upload_admission.sql`, then `20261015010000_production_hardening.sql`. Do not edit a migration already applied to a hosted environment.
4. Deploy the new server and restart workers. The new dense caller requires `match_document_chunks_v2`; deploying code first would break dense retrieval. Policy/function replacement takes schema locks and may briefly block writes. Schedule a maintenance window; no destructive table rewrite is required.
5. Confirm the singleton `ingestion_limits` row and set limits deliberately. Defaults: 20 pending files/user, 200 MiB pending bytes/user, three global active workers. `INGESTION_WORKER_CONCURRENCY` remains a per-process ceiling (1-5); `QV_EMBED_CONCURRENCY` is a separate per-process HTTP ceiling (default 2). All processes share database active-job capacity.
6. Reindex READY PPTX documents with parser_version below 2, and documents whose embedding model/version metadata does not match the deployed provider. Do not mix query vectors with older model spaces merely because their dimensions match.

### Read-only verification queries

```sql
select * from public.ingestion_limits;
select id, filename, parser_version from public.documents
where status='ready' and lower(filename) like '%.pptx' and coalesce(parser_version,0)<2;
select status, count(*) from public.ingestion_jobs group by status;
select id, document_id, attempt_count, max_attempts, locked_at
from public.ingestion_jobs where status='running'
  and (locked_at is null or locked_at < clock_timestamp()-interval '300 seconds');
select embedding_model, chunking_version, status, count(*)
from public.documents group by embedding_model, chunking_version, status;
select count(*) as inconsistent_ready_chunks
from public.document_chunks c join public.documents d on d.id=c.document_id
where d.status='ready' and (c.user_id is distinct from d.user_id
  or c.chunking_version is distinct from d.chunking_version
  or c.embedding_model is distinct from d.embedding_model);
select has_function_privilege('authenticated',
  'public.mutate_ingestion_claim(uuid,text,integer,jsonb,jsonb,jsonb,integer)','execute');
-- The final privilege check must return false.
```

### Recovery and rollback

Prefer forward fixes. A rollback to the Phase 1 application can retain these additive database protections; both versions use the same fenced mutation signature. Keep workers stopped while validating compatibility. Never restart unfenced older workers as a shortcut. If schema/application rollback cannot preserve invariants, restore the pre-deployment backup to an isolated project, verify documents/chunks/Storage together, and perform an explicitly approved cutover. Do not automatically drop tables, undo chunk versions, delete originals, or restore production from this audit script.

## E. Verification results

Final local verification results are recorded below. Native Vite configuration and a single Vitest worker avoid Windows config-bundling/process contention; assertions and quality thresholds were not reduced.

| Command | Final result |
| --- | --- |
| `npm test -- --configLoader native --maxWorkers 1` | 523 passed, 2 opt-in live tests skipped; 31 files passed, 1 skipped |
| `npx tsc --noEmit` | Passed |
| `npm run lint` | No errors; 14 existing warnings |
| `npm run eval:gate` | Retrieval gate and 12 answer-safety checks passed |
| `npm run build` | Passed |
| `npm run security:client` | No configured private key values found in public output |
| `npm run test:db` | 13 passed on real isolated PostgreSQL/pgvector |
| `npm run test:e2e` | 2 mocked tests passed; 1 hosted-write test skipped |

- `npm run test:db` with `QV_DB_TEST_CONTAINER=queryvault-phase2-db`: 13 real local PostgreSQL integration checks passed.
- An intermediate browser run failed because a 60 ms mocked upload could complete between polls. Replacing the delay with an explicit release barrier fixed the test race; the final run passed without weakening concurrency assertions.
- `npm run test:e2e`: mocked batch, refresh, citation and two-pixel anchoring checks passed. The original hosted database-writing test is deliberately skipped unless `QV_E2E_ISOLATED=1` designates an explicitly isolated project; mere credentials do not authorize test writes.
- `npm run eval:gate`: existing retrieval thresholds passed plus 12 new deterministic runtime answer-safety checks. This does not grade real model entailment accuracy.
- Optional live Gemini embedding fixture: one real request passed, produced 3072 finite dimensions; test execution took 601 ms in that recorded run.
- Optional live Gemini verifier fixture: failed the supported-answer assertion; both calls returned HTTP 503. This is a real failed check, not a skip or successful refusal-quality score. See [provider evidence](phase2/live-verifier.json).
- Registry-backed `npm audit --json`: 13 advisories remain (zero critical, zero high, six moderate, seven low). Remaining groups include Vitest development tooling, Mammoth's CLI formatting dependency chain, and KaTeX/math rendering. No forced Mammoth downgrade or feature removal was used. Review reachability and upstream patches before accepting these risks. See [dependency evidence](phase2/dependencies.json).

## F. RAG reliability

Older PPTX documents are excluded from dense/lexical retrieval until parser-version-2 reindexing restores reliable slide locators. All/selected scope still enforces owned READY documents; empty explicit selection fails. Dense retrieval additionally requires the configured embedding model and published chunk version. Lexical retrieval requires the published version. Existing relevance gate, token budget, reranking and document diversity remain.

The refusal now exactly follows the Phase 2 requirement: **"I couldn't find sufficient information about this in your uploaded documents."** Model text is buffered before syntax, block, exact-quote and semantic support verification. Unknown/out-of-scope citations, formatting-hidden factual claims, unsupported quotations (including short/single-quoted ones), provider failures and truncated verifier verdicts fail closed.

Conflict detection scans already-authorized retrieved excerpts locally for different numeric/date values attached to the same relevant field. Equivalent numeric formats are normalized; different units/years are not conflated. A detected difference produces a fixed server-authored answer quoting and citing both statements, with no additional generation or verification disclosure. It does not decide which version is authoritative. Semantic, negated, paraphrased or unretrieved contradictions may be missed. No universal agreement is inferred.

Summary answers are explicitly labeled as summaries of retrieved excerpts with potentially incomplete coverage. Exhaustive hierarchical summarization is not implemented or claimed. The earlier rejection of sending all retrieved snippets to a verifier has not been circumvented; semantic verification still receives only the passages associated with cited claims. Model verification is probabilistic and can make mistakes; it is not a zero-hallucination guarantee.

## G. Performance

[Measured fixture data](phase2/performance.json) covers 1, 5, 10 and 20 mixed-size UTF-8 documents on Windows/Bun. Hashing, extraction, chunking, fusion, heuristic reranking and context construction run real code. Embeddings have an explicit simulated delay, indexing uses an in-memory map, and transport/database/provider latency is not represented. Measurements are a single sequential local run, include warmup variance, and RSS peaks are sampled; they are **not production throughput or capacity claims**.

| Documents | Fixture wall ms | Retrieval ms | Sampled peak RSS MiB | Peak workers | Chunks |
| --- | --- | --- | --- | --- | --- |
| 1 | 13.91 | 1.62 | 87.70 | 1 | 3 |
| 5 | 53.57 | 1.37 | 90.45 | 3 | 119 |
| 10 | 81.35 | 2.80 | 92.58 | 3 | 294 |
| 20 | 152.01 | 3.62 | 95.68 | 3 | 623 |

Live upload, provider generation, database vector-query latency, first validated answer byte, full-answer latency and dollar cost remain unmeasured. The app emits validated text only after generation and verification, so raw model first-token latency is not client first-response latency. The live verifier failure contains no successful token usage to price. Do not extrapolate the fixture timings to hosted ingestion.

## H. Deployment readiness

- **Verified and ready for review:** deterministic tests/build, local real database invariants, bounded client/worker execution, private diagnostics defaults, dependency critical/high remediation, runtime safety gates and mocked browser workflows.
- **Requires manual verification:** complete isolated Supabase Auth/Storage/scheduler flows, signed URL expiry/abort cleanup over real networks, representative provider-backed 1/5/10/20-document load, backup restoration and reindexing legacy metadata.
- **Blocked by external service/approval:** Gemini support verification currently receives 503; hosted migrations require explicit production approval and have not been applied.
- **Known limitations:** OCR preprocessing; finite retrieval/context budgets; conservative/incomplete conflict detection and semantic verification; excerpt-only summaries; residual moderate/low dependency advisories; no measured production costs/capacity.

## I. Remaining actions before deployment

1. Re-run synthetic embedding and support verification when Gemini is healthy. The supported fixture must pass and the fabricated fixture must fail; do not disable the verifier to restore availability.
2. Designate an isolated Supabase project, apply both migrations there, configure the private bucket and Vault/scheduler secret, and run the original hosted test with `QV_E2E_ISOLATED=1`. Never set that flag against production credentials.
3. Exercise real upload abort, orphan cleanup/resume, close-browser ingestion, duplicate content, corrupt Office/PDF, OCR-only files, two users and selected/all-document questions. Verify persisted citation mappings after refresh.
4. Resolve or explicitly review remaining dependency risks, enforce container CPU/memory limits, bind developer/test services to loopback, and repeat client-secret scanning on the actual deployment artifact.
5. Back up and test restoration, obtain production migration approval, pause old workers, migrate in order, deploy, restart workers/scheduler, and run the read-only checks above. Monitor queue depth, lease age, retry/terminal failures, embedding deadlines, verifier failures/status and end-to-end latency using structured metadata.
6. Keep `QV_TRACE_CONTENT=0` by default. Any temporary private diagnostic capture needs explicit operator consent, RLS access review and a short retention policy; disable it after diagnosis.

Reproduce local database checks without a hosted URL:

```powershell
docker run -d --name queryvault-phase2-db --network none -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=queryvault_audit pgvector/pgvector:pg17
$env:QV_DB_TEST_CONTAINER='queryvault-phase2-db'
npm run test:db
# The runner creates/drops its own database and rejects host bind mounts/networking.
docker rm -f -v queryvault-phase2-db
```

The tested image digest was `sha256:ac08538c6f8b9904c33c8224c5e5706dbe760aca29db1d096972b4052c22a75d`. Pin that digest for reproducibility. Full operational setup remains in [DEPLOYMENT.md](DEPLOYMENT.md) and [CONCURRENT_INGESTION.md](CONCURRENT_INGESTION.md).

## Primary references

- [Gemini thinking configuration](https://ai.google.dev/gemini-api/docs/generate-content/thinking)
- [Gemini embeddings](https://ai.google.dev/gemini-api/docs/embeddings)
- [Official SheetJS Node installation](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/)
