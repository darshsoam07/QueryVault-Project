# Concurrent uploads and grounded retrieval

The primary root application owns this pipeline. The local-stack application is unchanged.

## Deployment order

Apply `supabase/migrations/20261015000000_atomic_upload_admission.sql` followed by `20261015010000_production_hardening.sql` before starting the updated server/worker. This change has NOT been applied to a remote database by this implementation. `supabase/bootstrap.sql` includes the migration; regenerate with `bash scripts/generate-bootstrap.sh` after future schema changes. Database TypeScript declarations include the new settings table and fenced mutation RPC.

Stop old workers before migration and restart all workers with the updated code. Old workers do not use the fenced mutation function. Keep the private Storage bucket, existing scheduler secret, authenticated worker-drain route, and service-role credentials on the server. No new queue service is required.

## Limits

- Upload scheduler: three simultaneous uploads per mounted knowledge panel. Slots end at durable enqueue, not at ingestion completion. Browser tabs have independent schedulers; Postgres admission is shared across them.
- Per file: existing supported formats, minimum 100 bytes and maximum 25 MiB. Stored bytes and SHA-256 must match the reserved original before indexing.
- UI batch defaults: 20 files and 200 MiB. Build-time `VITE_UPLOAD_BATCH_COUNT` and `VITE_UPLOAD_BATCH_BYTES` change these. Use positive integer values and align them with database admission settings.
- Atomic admission: `public.ingestion_limits.queued_per_user` (default 20) and `pending_bytes` (default 209715200) bound pending reservations, including uploads without a job. A per-owner transaction lock serializes concurrent inserts. The former count-then-insert environment cap is superseded by this table.
- Global active jobs: `ingestion_limits.global_workers`, default 3. Claim transactions serialize capacity accounting across drains, scheduler calls and processes. `INGESTION_WORKER_CONCURRENCY` defaults to 3 and is clamped to 1-5 per process; overlapping drains in the same process serialize. `maxJobs` can reduce a drain's size, never increase its process ceiling. Effective concurrency is the smaller of available global capacity and process capacity.
- Embedding HTTP calls: `QV_EMBED_CONCURRENCY`, default 2, clamped to 1-16, per process (including retrieval embeddings). It is not a global provider-account ceiling. The existing database-backed per-owner embed request rate limit also applies to ingestion batches. Multiple application processes may issue embedding calls concurrently; size global job capacity and provider quotas accordingly.
- Explicit selection: `VITE_MAX_DOCUMENT_SELECTION`, default 100, constrained to 1-100, shared by UI and server at build time. Missing/null selection means all owned READY documents; `[]` is an error. Every explicitly requested ID must be owned and READY. Both SQL retrievers filter ownership, status and scope before ranking and limits.

For example, an administrator may run in an isolated deployment:

```sql
update public.ingestion_limits
set queued_per_user = 20, pending_bytes = 209715200, global_workers = 3
where id;
```

This table has RLS, no browser grants and no public policies. It must retain its singleton row.

## Queue and recovery

Each file gets an independent queue entry and retry control. Repeated filenames do not identify entries; UUIDs do. Invalid files do not stop valid siblings. Files can be added while indexing runs. Signed uploads use XHR byte progress and abort; the legacy Storage SDK fallback supports cancellation checks and cleanup after completion rather than transport abort.

After enqueue, ingestion is durable and independent of browser polling. A polling timeout reports background indexing rather than READY or job cancellation. Refresh recovers document status from Postgres. Upload errors and enqueue errors attempt deletion of both the original and reservation. If cleanup cannot complete, the visible document/deleting record remains recoverable through the knowledge-base delete action. Do not automatically delete completed originals.

Claims have five-minute leases, renewed every thirty seconds using the fenced RPC and database time. Every pipeline write checks job ID, worker ID, attempt number, lease and document state under row locks. Reclaimed workers cannot write chunks, fail a new attempt or publish READY. Deleted documents cannot be resurrected. Retry uses existing bounded backoff and failure classification.

Reindex enqueue immediately removes READY visibility. Chunk IDs remain deterministic; writes are upserts. Stale chunks are pruned and all required embeddings checked in the same transaction that publishes READY and succeeds the job. Partial indexes remain excluded from retrieval.

## Retrieval and answers

Dense and lexical retrieval each cap a document at eight candidates when multiple documents match (up to sixty for a single matching document), before the global sixty-candidate limit. Fusion/reranking admit thirty-two candidates. Context prioritizes the strongest relevant passage from each represented document, then fills remaining slots. It allows twelve sources within 6400 estimated tokens; no irrelevant document is inserted merely for diversity. Finite candidate and token budgets still limit coverage in large corpora.

Evidence filenames and text are escaped before XML-like prompt serialization. Prior assistant answers are excluded from generation context. Prior user turns only resolve references. Client system-role messages are rejected. There is no web or general-knowledge fallback.

Before emission or assistant persistence: the existing evidence gate, citation syntax/block validation, exact-quotation checks, formatting-exemption audit and a separate entailment verifier must pass. The verifier sees each block with only its cited passages, plus the question for comparison/partial-coverage checks. Unsupported claims fail closed to the fixed GROUNDED_REFUSAL. Verifier outages, timeouts and malformed provider verdicts return AI_UNAVAILABLE before answer delivery or assistant persistence; see GEMINI_VERIFIER_HARDENING.md. No rejected candidate is emitted, saved, or logged. Completed delivery and saved history use the same validated answer and cited-source mapping.

Semantic verification is probabilistic and can still err, especially with ambiguous documents, conflicting language or sophisticated prompt injection. It does not guarantee zero hallucinations. Verification is limited to each claim and its associated cited passages; automatic approval review rejected expanding the verifier prompt to all retrieved snippets and filenames, so detecting an omitted conflict elsewhere in the evidence remains a limitation. Explicit comparison wording with selected documents additionally requires each selected document to appear in context; otherwise it refuses before generation. Conservative checks can refuse supported paraphrases, uncited structural headings, or complex comparisons. Partial answers and disagreements must be supported by their associated passages; complete comparison coverage is checked by the verifier, not a formal proof.

Citation markers open request-scoped evidence popovers. Locators distinguish PDF pages, slides, worksheets and unpaginated evidence excerpts. Existing extraction does not retain precise spreadsheet row ranges or DOCX pagination, so those are not invented. OCR is still required before uploading scanned/image-only documents.

## Verification

Deterministic Vitest tests mock storage/database/provider boundaries. They measure real overlapping uploads, ten-job worker orchestration with concurrency/maxJobs ceilings, independent failures, queued cancellation, deletion before publication, explicit empty/foreign/non-ready scope rejection, multi-document context coverage, delimiter escaping, formatting-hidden claims, exact quotes, support-verifier outages, and refusal delivery/persistence. These fixtures do not prove deployed Postgres locking behavior.

Run `npm run typecheck`, `npm run lint`, `npm test -- --configLoader native --maxWorkers 1`, `npm run build -- --configLoader native`, `npm run test:e2e`, and `npm run eval:gate`. Native config loading avoids a Windows Vite config-bundling issue observed in this environment. Evaluation is deterministic fixture evaluation, not live provider verification. Existing credential-dependent checks remain separately skipped when unavailable.

Before release, use an isolated Supabase project with this migration and two test users:

1. Select/drop ten distinct valid documents, plus corrupt, oversized, unsupported, duplicate and OCR-required fixtures. Confirm three uploads overlap, valid siblings reach READY, failures are independent, and another file can be added during processing. Cancel one queued upload and one signed XHR upload; inspect cleanup/recovery.
2. Set admission to one and submit simultaneous reservations from two sessions. Exactly one distinct reservation must succeed. Restore limits. Start overlapping drains from two processes; verify global and per-process ceilings, unique live claims and thirty-second renewals.
3. Kill a worker, expire its lease in the isolated database, reclaim it, and attempt the old token's fenced RPC. It must return false with no writes. Delete a document during embedding, retry a transient failure and reindex a READY file. Check no resurrection, duplicate chunks or retrieval of partial versions.
4. Ask a three-document question and a question requiring eight passages; include one long repetitive distractor. Inspect claims, excerpts and locators, click citation markers, refresh history, and compare saved mappings. Repeat with selected-only, all-document, empty, foreign and non-ready scopes.
5. Ask an absent-answer question, a partial-coverage comparison, conflicting-document question, forged citation/quote and injected document/chat instructions. Verify refusal or supported-only claims and that rejected candidates never appear in the network stream or messages table.
6. Close the browser after enqueue, run scheduler/worker separately, then reopen and confirm READY status. Check original files remain private and cross-user queries return no evidence.

Live race/reclaim/migration/provider acceptance remains a deployment verification requirement; do not infer it from mocked tests or the static migration security checks.

## Historical Phase 1 checks (15 October 2026)

These are Phase 1 results, superseded by [the Phase 2 audit](PHASE2_AUDIT.md), including real local Postgres checks and the live verifier failure.

- TypeScript: passed.
- ESLint: passed with 14 existing warnings and no errors.
- Vitest (native Vite configuration, one worker): 500 passed, one skipped across 29 files. The skipped check is the opt-in live Gemini embedding request (`RUN_LIVE_GEMINI_TESTS` plus `GEMINI_API_KEY`).
- Production build (native Vite configuration): passed.
- Bun evaluation gate: passed without changing thresholds.
- Playwright: passed the unchanged chat-history pagination and 2 px scroll-anchor tolerance. The restoration now retains a visible message anchor through delayed markdown/font layout changes.
- New migration application, simultaneous database admission races and multi-process lease reclamation: not executed against a live database. Applying the migration remotely would be a deployment, which was explicitly excluded from this task.

Live deployment acceptance still requires the isolated database checks above. Changes remain local; no push or deployment was performed.
