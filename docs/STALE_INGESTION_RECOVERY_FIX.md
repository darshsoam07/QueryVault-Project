# Stale ingestion recovery fix

Date: 2026-10-21. **Verdict: PARTIAL.** Local defects have regression coverage. The production job has not been mutated, resumed or observed recovering. The supplied production snapshot confirms a stale lease, not the precise blocked call.

## 1. Confirmed root cause versus hypotheses

For job 10ce5e60-1e73-4e15-bd2c-c984f7d65da0, the supplied snapshot at 23:11:09 IST showed running/attempt 1, locked_at 22:53:16 IST, age 1,073 seconds, expired lease; document uploaded/queued/progress 5/chunks 0; no failure code. The 300-second lease was not being successfully renewed. No successful first validating transition was visible at observation time. This excludes normal processing under a healthy lease. A missing initial worker is contradicted by the claim and ingestion.started event.

Confirmed source defects before the local hardening: post-start database awaits could remain unresolved; heartbeat responses/rejections were not checked; a never-settling drain occupied the one local drain slot; read failures could be mistaken for cancellation and polling could fabricate queued state. These can combine to strand a running row while later local drains wait. An expired row is recovered only when another successful claim call executes; expiration alone is not a scheduler.

**The historical initiating call is still unknown.** A database/network stall, first mutation rejection, stopped process, development restart, event-loop suspension, unreachable scheduler or older deployed RPC are possible. The snapshot does not prove which occurred. No production reads, mutations, new worker processes or provider calls were made. Actual hosted migration versions, cron execution and Vault configuration remain unverified.

## 2. Exact failure path and worker lifecycle

The observed path is upload -> enqueue -> atomic claim -> metadata lookup -> ingestion.started -> live claim read -> document live read -> setPhase validating (status read, fenced mutations). The initial metadata lookup already returned before the start event. There is no embedding, parsing or Storage call between that event and first validation. Those later operations are not supported explanations for failure to reach the initial validating boundary, unless additional unseen activity or state changes occurred.

A hung read/write before validation previously prevented the drain from settling. The old heartbeat could fail/reject silently, leaving the row running without renewal. A later drain in the same module instance waited behind UploadQueue(1); a fresh process or module instance has its own queue, but must still pass SQL global admission/fencing. No evidence establishes whether this particular process remained alive or whether subsequent drains were invoked.

npm run dev starts Vite. Upload/reindex request handlers issue a best-effort, fire-and-forget drain; the browser does not own queue state. These wakeups are not a durable worker loop. Process termination loses promises/timers. Reload or module invalidation may replace module instances; it does not guarantee either termination or continuation of previous tasks. Database fencing is required in either case.

npm run worker uses the existing dedicated Bun worker loop. It awaits each drain, polls at 2–5 second intervals and stops accepting new cycles on SIGINT/SIGTERM while allowing the current cycle to settle. A dedicated supervised worker is the appropriate authoritative local execution process for an explicitly isolated local configuration; browser wakeups are only accelerators. It was not started against the current production configuration. Nothing in this patch changes execution mode automatically or starts additional processes.

## 3. Changes and rationale

This patch builds on the preceding local stall hardening, preserving those changes:

- worker.server.ts retains bounded stages, safe error classification, checked/serialized heartbeats and honest unconfirmed failure-persistence outcomes. It now logs drain requested/started with wait duration, each claimed attempt and successful lease renewals. Errors, false responses and rejected renewal promises are distinct from renewal success. Failed renewal stops that timer.
- lease.ts defines the existing 300-second application lease constant and advisory active/expired/unknown/not_running classification. Database clocks and mutations remain authoritative; UI clock comparisons never grant claims.
- documents.functions.ts includes locked_at and a server-observed lease state in read-only status, keeps owner filters/deadlines, and logs best-effort wakeup failure instead of swallowing it.
- ingest.ts reports Recovery pending for expired running jobs, retains the confirmed phase and hides determinate progress. It continues read-only monitoring and can follow a later reclaimed attempt.
- KnowledgePanel.tsx reads minimal running-job metadata through an owner-scoped left relationship and existing RLS. The unique live-job index limits the filtered relationship to at most one job per document. After refresh/remount, expired work shows Recovery pending and an expired-lease message. Documents without running jobs remain visible. No drain or job mutation is triggered by this read.
- scripts/worker.ts includes cancelled and unconfirmed counts in cycle diagnostics.
- concurrent-worker, ingestion-polling and KnowledgePanel regressions cover the new paths; scripts/test-database.mjs strengthens real PostgreSQL recovery and publication checks.

The preceding async-deadline.ts and stage.server.ts bound database calls at 15 seconds, Storage at 30 seconds, parser promises at 60 seconds, local transforms at 15 seconds and embedding at 75 seconds externally (existing provider timeout unchanged). No timeout was broadly increased. All important post-start awaits have stage diagnostics. Logs contain identifiers, stage, attempt, elapsed time, outcome and safe codes; no private text, vectors, headers or secrets.

## 4. Lease and concurrency safety

The one-process drain lock is deliberately retained. It must not be released using Promise.race over an uncancelled pipeline: that could admit overlapping processing while old work continues. Instead, each external asynchronous stage has a deadline and SDK abort signal where supported; its rejected await ends the pipeline before the serialized slot is released. Late results are ignored. A blocked first-phase request is fault-tested with a subsequent waiting drain, which claims only after the first settles.

Atomic claim SQL still serializes global capacity admission and uses SKIP LOCKED; only nonexpired running claims consume active capacity. Claim attempts increment on reclaim. mutate_ingestion_claim checks job identity, worker identity, attempt, running state, unexpired lease, document existence and the lease again after obtaining the document lock. An old process cannot renew, write chunks or publish READY after reclaim. A transient failed renewal alone does not prove ownership loss; SQL guards every subsequent mutation. A false renewal is never logged as successful.

No queue lock removal, unbounded worker creation, dimension/model change, forced READY, retry reset, concurrency increase or SQL migration is included. Retry budget and backoff remain unchanged, including the stored max_attempts ceiling. Exhausted crash recovery atomically marks the job/document failed when the next claim sweep runs. Final READY remains an atomic publication requiring a complete matching index. A lost response may accompany an already committed READY; the worker does not undo that success.

Limits: Abort cannot prove a transaction rolled back, and JavaScript deadlines cannot preempt synchronous CPU-bound parser code or a suspended event loop. Existing parser resource limits remain. A genuinely non-cooperative CPU stall requires process supervision/termination, followed by lease expiry and a healthy claimant; it cannot safely be fixed by releasing a local lock while that process runs. Provider and database outages can defer persisted failure, so unconfirmed outcomes are reported honestly rather than fabricated failure/success.

## 5. Recovery and scheduler behavior

The next healthy drain reclaims due expired running work through the existing claim RPC. A fresh process has no old in-memory lock; the database still controls admission. An already alive process progresses after bounded failed stages settle. Recovery needs a live caller and working database, not a browser refresh. No automatic production recovery was invoked here.

The scheduler migration 20260904000000_schedule_ingestion_worker.sql installs Vault support and a single named minutely pg_cron job; pg_net is enabled by an earlier migration. trigger_ingestion_worker reads the drain URL and shared secret from Vault at execution time, returns false when either is absent, and queues a net.http_post. Its true result means a request was queued, not authenticated processing success. pg_net has a 1,000ms request timeout while the route awaits a full drain; this needs separate end-to-end validation on the intended host. Do not assume a timed-out HTTP client proves server execution ended or succeeded.

The route /api/public/worker-drain fails closed using constant-time x-worker-secret comparison; it awaits the same bounded drain. It does not accept public unauthenticated execution. No secret values were inspected or printed. A cloud scheduler cannot reach a developer machine through localhost:8080: localhost refers to the scheduler's own host. A deployed reachable endpoint or separately authorized local dedicated worker is necessary. Actual Vault URL presence/host, secret match, extensions, schedule state and response status were not queried in production. No tunnel or deployment was created.

## 6. Regression results

All tests use synthetic mocked providers or an isolated disposable PostgreSQL/pgvector fixture; no live ingestion or inference occurred.

| Check                                            | Actual result                                     |
| ------------------------------------------------ | ------------------------------------------------- |
| Targeted worker/polling suite                    | 31 passed                                         |
| Targeted KnowledgePanel DOM suite                | 24 passed                                         |
| npm run typecheck                                | Passed                                            |
| npm run lint                                     | 0 errors; 14 existing warnings                    |
| npm test -- --configLoader native --maxWorkers 1 | 589 passed; 2 skipped; 35 files passed, 1 skipped |
| npm run build                                    | Passed                                            |
| npm run security:client                          | Passed; no client secret violations               |
| npm run test:db                                  | 14 real local PostgreSQL/pgvector checks passed   |

The two skipped tests are opt-in live provider/verifier tests in provider-live.test.ts and gemini-provider.test.ts. Playwright, standalone RAG evaluation, real provider ingestion and hosted scheduler acceptance were not run for this task; no earlier results are represented as current passes. The KnowledgePanel test is DOM-based with a mocked Supabase boundary, not a live browser/PostgREST acceptance test.

An interim full run encountered 15 UI failures while the relationship query and its mock were being updated. The completed mock supports the actual query builder; the fresh final full run passes with all original assertions retained. No failing assertion was removed or skipped.

The cached pgvector image was started with --pull=never, network none and no host bind mounts. The runner refuses a database URL or hosted .env and applies migrations only inside its randomly named disposable database. Auth/Storage are SQL scaffolding; cron/net/Vault are excluded. The container and anonymous volume were removed afterward. See [database evidence](stale-ingestion-recovery/local-database.json) and [test summary](stale-ingestion-recovery/results.json).

Coverage includes successful claims; first phase database errors; heartbeat success/error/false/rejection; bounded blocked network calls; queued drain continuation; interrupted-before-validation database state; expired lease reclaim and incremented attempt; stale renewal and write rejection; exhaustion; complete matching READY; repeated READY rejection; and browser recovery state after interruption/remount.

## 7. Manual verification (requires a separately approved isolated target)

1. Keep the current production environment untouched. Prepare a separately designated loopback-only Supabase configuration using the earlier local acceptance checklist; do not run npm run worker with the existing production .env. No installations/downloads are approved here.
2. Run the offline test commands listed below. The database runner only accepts a disposable queryvault-phase2-* Docker container with network none and no host mounts, and never reads .env or accepts a database URL. Use --pull=never and the already cached image; do not download missing images.
3. In the approved isolated environment, start exactly the intended dedicated worker process. Keep AI disabled under the zero-cost profile unless a separate provider test is explicitly authorized with confirmed free eligibility. AI_DISABLED is expected at provider admission, not READY.
4. Observe worker.drain_requested, worker.drain_started, worker.claimed, worker.stage and worker.lease_renewed by job/attempt. A requested drain without started indicates local queue waiting. A stage start without completion/failure identifies an outstanding await; STAGE_TIMEOUT identifies a bounded failure. worker.failure_recording_deferred means database failure could not be persisted; do not call it recovered.
5. Only in the isolated fixture, terminate after claim and before validation, wait for lease expiry, then run one healthy drain. Verify attempt increments, old worker/attempt mutations return false, and no duplicate chunks or READY publication occurs. Exhaustion must fail both job/document. The SQL regression suite executes these state transitions without waiting five minutes by aging only its disposable fixture.
6. Refresh the browser: expired running work must show Recovery pending; queued work stays queued; read errors show unavailable status; an authorized later reclaim updates to actual phases. Refresh never starts a worker. READY requires a complete matching index. No live READY assertion can be satisfied by mocks.

For production investigation, request only a separately authorized read-only snapshot of job status/attempt/max_attempts/locked_at/available_at/error_code and document status/phase/progress/chunk_count/failure_code, twice 30 seconds apart. Do not share raw messages, filenames, keys or content. Compare migration ledger/RPC signatures, cron extension presence and sanitized scheduler response codes without displaying Vault secret values. These inspections were not performed here.

## 8. Remaining external dependencies

The exact historical failing await and runtime/process lifecycle remain unobserved. Hosted schema, scheduler reachability, authorization, response timeout behavior and configured secret parity are unverified. Full local Supabase Auth/Storage HTTP acceptance needs approved components; the PostgreSQL fixture scaffolds those schemas and excludes cron/net/Vault. Real embeddings and complete document acceptance remain blocked by the explicit no-new-AI-request and unverified-free-quota restrictions. No live throughput is reported.

## 9. Rollout and rollback plan (not executed)

Before any rollout: obtain explicit approval; review the entire local diff including preceding hardening; verify hosted migration/RPC compatibility read-only; choose one supervised execution path and validate scheduler response/lifecycle behavior; pass isolated Auth/Storage and provider acceptance under approved cost/privacy conditions. Record a clean release identifier and a rollback artifact. Models, dimensions and verification requirements stay fixed.

Deploy only with explicit approval. Monitor stage latency, renewal failures, expired lease count, attempt ceilings, unknown status and failure-recording-deferred events. Let existing leases and claims govern recovery; never manually force READY or reset attempt budgets. Verify a separately authorized synthetic job end to end before declaring recovery.

Rollback only the reviewed application release/configuration using the previous artifact; do not reset the database, rewrite git history or delete jobs/chunks. Stop accepting new cycles in the replaced worker, preserve valid leases, and allow replacement workers to reclaim only after expiry under the same fencing rules. No schema migration is needed for this patch. No production rollout or rollback occurred.

## 10. Verdict

**PARTIAL**: the production snapshot confirms stale running work, and local failure/recovery behavior is tested. The initiating production failure and actual production recovery are not verified. There were no hosted writes, mutating RPCs, downloads, model changes, new AI requests, billing changes, pushes, merges or deployments.
