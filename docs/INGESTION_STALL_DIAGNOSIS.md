# Ingestion stall diagnosis

Date: 2026-10-21. Verdict: **PARTIAL**. Confirmed local defects are fixed and fault-tested. The exact cause of the supplied live job remains unconfirmed; mocked success is not live indexing acceptance.

## 1. Confirmed defects and remaining uncertainty

The supplied logs prove job 10ce5e60-1e73-4e15-bd2c-c984f7d65da0 was claimed and reached ingestion.started on ingest-worker@4, attempt 1. A missing worker is not the supported diagnosis. Metadata lookup precedes that event and therefore returned in the reported run.

Code inspection confirmed unbounded post-start database, Storage and parser awaits. Periodic lease renewal could keep a stalled attempt alive indefinitely. Read errors were confused with cancellation or missing documents, Storage errors with missing objects, and failure recording could silently discard the original failure. The frontend returned a fabricated queued snapshot on polling errors without notifying its status callback. These defects can hide real progress/failure; none alone proves the cause of this particular live incident.

No attached terminal, captured later stage events or fresh database snapshot was available. The configured Supabase endpoint is remote; its zero-cost eligibility is unverified. No hosted query or mutation was performed. A sanitized snapshot was requested but not supplied during this investigation.

## 2. Exact blocking stage

**Unknown for the live job.** The first await after ingestion.started is the live-claim check; subsequent phase writes, download, hash, parse, chunking, provider admission, embedding and vector/publication writes remain candidates. New worker.stage events now name these boundaries, with started/completed/failed, elapsed milliseconds, job/document identifiers, attempt and safe error code. They contain no document text, vectors, filenames, credentials or raw provider diagnostics.

A completed stage means the request returned; a rejected database response is classified by the subsequent job outcome. Request timeout does not prove a database transaction rolled back. Atomic fencing remains authoritative, including a READY transaction whose response is lost.

| Candidate                     | Evidence and discrimination                                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: Database blocked           | Reproduced with a hanging phase write; bounded at 15 seconds. Live case unknown.                                                                              |
| B: Storage blocked            | Reproduced hanging download; bounded at 30 seconds. 503 retries; actual missing object is terminal. Live case unknown.                                        |
| C: Parser stalled             | Hanging parser promise reproduced; 60-second deadline. Live case unknown.                                                                                     |
| D: Provider unavailable/quota | Mocked quota is terminal and hung embedding bounded. No new AI request; live case unknown.                                                                    |
| E: Invalid lease              | Existing claim replacement/deletion tests preserve fencing. Actual read failures no longer masquerade as cancellation. Live lease unknown.                    |
| F: Schema/dimension mismatch  | Missing RPC and rejected vector-write tests classify failures; existing model/dimension guards preserved. Hosted schema unknown.                              |
| G: Polling/rendering          | Confirmed code defect and reproduced recovery tests; UI retains last confirmed phase and indicates unavailable status. Contribution to live incident unknown. |
| H: Normal processing          | Still possible without elapsed-time/progress snapshots. Zero indexed alone does not establish worker failure.                                                 |

## 3. Supporting runtime evidence

Only the user's upload/queue/start logs describe the live job. Local synthetic faults provide stage-specific reproduction, not measurements of live throughput. A cached PostgreSQL/pgvector image ran in an isolated network-none container with no host mounts; all 13 database integration checks passed. Its disposable container and anonymous volume were removed. Database fixtures scaffold Auth/Storage SQL; they do not validate actual Supabase Auth or Storage HTTP services. See [local database evidence](ingestion-stall/local-database.json).

## 4. Files modified

- src/lib/async-deadline.ts: abortable request deadlines and cancellation-aware polling delays.
- src/lib/ingestion/stage.server.ts: sanitized stage diagnostics and explicit per-operation budgets.
- src/lib/ingestion/worker.server.ts: bounded I/O, error classification, bounded heartbeat monitoring and honest failure-persistence outcomes.
- src/lib/ingestion/contract.ts: disabled AI is terminal AI_DISABLED, not a transient provider outage.
- src/lib/documents.functions.ts: bounded status reads; query failures are not fabricated missing documents/jobs; explicit job ownership filter.
- src/lib/ingest.ts: bounded polling, transient recovery and last-known phase preservation.
- src/components/queryvault/KnowledgePanel.tsx: stale-status warning, indeterminate unknown progress and read-only refresh recovery.
- Three regression files: concurrent-worker.test.ts, ingestion-polling.test.ts and KnowledgePanel.test.tsx.

No SQL migration, model, vector dimension, provider, parser architecture, queue topology or concurrency setting changed.

## 5. Before and after

Database operations now have a 15-second budget; Storage 30 seconds; parser 60 seconds; local transformations 15 seconds; embedding outer stage 75 seconds (existing provider request timeout remains unchanged). Client status requests are bounded within the polling budget; three consecutive read failures report monitoring unavailable, not permanent queued or document failure. A later successful snapshot restores current status. Manual Refresh status reads only.

Deadlines abort transports where the SDK supports it and settle uncooperative asynchronous promises. They cannot preempt synchronous JavaScript parser CPU work; existing parser resource limits still apply. Heartbeats are monitored without overlapping renewals, and rejected renewals stop. Unconfirmed failure persistence is counted/logged, allowing the durable lease/recovery mechanism to remain authoritative. Actual database outages cannot guarantee visible persisted failure until service recovers.

Storage 404 remains missing-object failure; transient Storage faults retry within the existing attempt budget. Missing RPCs classify as RPC_SCHEMA_MISMATCH. A false fenced mutation is checked against live claim state rather than always called cancellation. Atomic READY still requires indexed chunks and compatible metadata. No status refresh drains the queue or creates duplicate vectors.

## 6. Actual verification

Targeted fault tests were run first (43 passed before the final additions). Final checks:

| Check                                                   | Actual result                                     |
| ------------------------------------------------------- | ------------------------------------------------- |
| npm run typecheck                                       | Passed                                            |
| npm run lint                                            | Passed: 0 errors, 14 existing warnings            |
| npm test -- --configLoader native --maxWorkers 1        | 580 passed, 2 skipped; 35 files passed, 1 skipped |
| npm run build                                           | Passed                                            |
| npm run security:client                                 | Passed; no client secret violations               |
| npm run test:db, disposable offline PostgreSQL/pgvector | 13 checks passed                                  |

The two skipped unit tests are opt-in live provider/verifier tests (provider-live.test.ts and gemini-provider.test.ts); no live AI success is claimed. Playwright and standalone RAG evaluation were not rerun in this ingestion-specific task; their earlier Phase 6 results are not represented as new results. Retrieval scope and atomic publication were checked in the local SQL suite.

An added lost-response test initially failed because fake timers raced native hashing, and was corrected to use real time without weakening its assertions. It now verifies committed READY is preserved after a lost response. Other regressions exercise phase-write, download, parser and embedding hangs; Storage 503/404; read errors; quota rejection; vector-write rejection; RPC mismatch; unconfirmed failure recording; polling interruption/recovery/cancellation; and cached-list refresh recovery.

## 7. Remaining blockers

- Exact live job state, latest lease/progress timestamps and last stage are unavailable.
- Hosted RPC/migration compatibility remains unverified; no hosted modifications were made.
- No approved new AI calls or verified free quota; real embeddings, complete document ingestion and real throughput remain blocked.
- Full local Supabase Auth/Storage acceptance still needs separately approved CLI/images installation. No downloads or installations occurred.
- Synchronous parser preemption would require a separate justified design change; it is not claimed here.

## 8. Manual read-only verification

In an already authorized database console, collect this restricted snapshot twice at least 30 seconds apart. Do not include keys, raw error messages or document content in shared output:

```sql
select clock_timestamp() as observed_at,
       j.id, j.status as job_status, j.attempt_count, j.max_attempts,
       j.locked_at, j.available_at, j.worker_version, j.error_code,
       j.locked_at + interval '300 seconds' as nominal_lease_expires_at,
       d.status as document_status, d.phase, d.progress,
       d.chunk_count, d.failure_code
from public.ingestion_jobs j
join public.documents d on d.id = j.document_id
where j.id = '10ce5e60-1e73-4e15-bd2c-c984f7d65da0';

select p.proname, pg_get_function_identity_arguments(p.oid) as arguments
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('claim_ingestion_jobs', 'mutate_ingestion_claim');
```

Read migration history and compare against repository migrations; do not apply them automatically. A renewed lease without phase progress warrants inspecting the named stage, not starting another worker. For the next separately authorized run of the patched worker, correlate worker.stage by job_id and attempt. The last started event without completed/failed narrows the await; STAGE_TIMEOUT identifies its budget. Inspect worker.job_retry/job_failed or worker.failure_recording_deferred to distinguish persisted failure from unavailable database state.

Refresh status must show database truth or an explicit stale/unavailable indicator. READY requires the successful atomic publication. Do not manually mark ready, requeue, reindex or run hosted drain calls to diagnose. Under dev:zero-cost, AI_DISABLED is the expected terminal outcome when indexing reaches provider admission; it is not successful live ingestion. Any new real provider run still requires explicit authorization and confirmed zero-cost eligibility.

## 9. Verdict

**PARTIAL**: confirmed reliability and status-reporting defects fixed locally; live root cause and real indexing readiness remain unproven. No push, deployment, hosted write, paid operation, provider request or model change occurred.
