# Isolated Supabase release acceptance

Status: **not executed against a full Supabase environment**. The real disposable PostgreSQL tests verify SQL invariants, not hosted Auth, Storage, Vault, cron/net, signed-URL HTTP or scheduler behavior. No hosted project has been designated for this run. Complete every applicable item and retain sanitized evidence before requesting production approval.

## 1. Establish the boundary

- [ ] Create/designate a disposable Supabase project with a distinct project reference and two synthetic users A and B. Record project reference, owner, date and reviewer. Do not copy real documents or production user data.
- [ ] Use a separate checkout/configuration directory containing the current reviewed code. Copy `.env.example` there and populate only isolated credentials. Do not reuse this workspace's `.env`. Confirm public URL/project ID, server URL, publishable key and service-role key all belong to the isolated project; never print secret values.
- [ ] Configure Auth redirect allowlist for the test origin. Set `QV_TRACE_CONTENT=0`, `AI_PROVIDER=gemini`, the intended Gemini model and existing embedding dimension 3072. Keep private credentials server-only. Set CPU/memory limits on workers.
- [ ] Record dependency-risk review, expected admission limits (20 files, 200 MiB, three globally active jobs), embedding concurrency (two per process), verifier limit (two active per process, no queued callers, three attempts, 15-second total budget). Cap replica count and provider project quotas: verifier cooldown is process-local, not distributed.

## 2. Apply migrations only in the isolated project

- [ ] Inspect `supabase/migrations` in filename order and confirm required extensions/roles and private bucket setup from `DEPLOYMENT.md`. On a fresh project apply existing migrations, then `20261015000000_atomic_upload_admission.sql`, then `20261015010000_production_hardening.sql`. With a locally available Supabase CLI:

```powershell
supabase link --project-ref <ISOLATED_PROJECT_REF>
supabase db push --dry-run
# Review target project and migration list before this isolated write:
supabase db push
```

- [ ] Retain migration output and ledger; confirm schema, RPC signatures, grants, enabled RLS and singleton `ingestion_limits`. The generated `supabase/bootstrap.sql` is an alternative for a fresh project, not a script to reapply indiscriminately to existing production tables.
- [ ] Configure Vault and scheduler target/secret according to the actual scheduler migration; verify pg_cron/pg_net jobs use the isolated URL. Reject unauthenticated worker-drain requests. Never log the worker secret.
- [ ] Run the read-only consistency queries in `PHASE2_AUDIT.md`; authenticated users must not execute `mutate_ingestion_claim`. Verify dense v2 exists before starting the new app. Document restoration from an isolated backup/export.

## 3. Build and baseline gates

```powershell
npm ci --ignore-scripts
npx tsc --noEmit
npm run lint
npm test -- --configLoader native --maxWorkers 1
npm run eval:gate
npm run build
npm run security:client
# Synthetic fixtures only, with the configured key in server environment:
$env:RUN_LIVE_GEMINI_TESTS='1'
npm test -- src/lib/__tests__/provider-live.test.ts --configLoader native --maxWorkers 1
Remove-Item Env:RUN_LIVE_GEMINI_TESTS
```

- [ ] Supported fixture returns `supported`; fabricated fixture returns `evidence_unsupported`. An outage returning false is **not** a passed fabricated-claim test. Check classifications, attempts and duration without recording prompts or provider bodies. Any timeout/503 blocks provider acceptance.
- [ ] Run `npm run dev -- --host 127.0.0.1 --port 5173` in the isolated checkout. For the production artifact, use the start command from `DEPLOYMENT.md` and repeat HTTP checks against that artifact.

## 4. Auth and RLS (users A and B)

- [ ] Sign up/sign in, refresh tokens, sign out, expired token, invalid token and unauthenticated routes. Expected: authenticated owner works; invalid/expired/absent credentials are denied without private data. Verify configured email/OAuth flows if enabled.
- [ ] A uploads synthetic documents and creates a thread. Using B's **user token**, attempt REST reads/writes, RPC retrieval, chat with A's document IDs/thread ID, job/status reads and signed downloads. Expected: denied/empty as appropriate; no filenames, chunks, messages, originals or evidence leak.
- [ ] Repeat with explicit empty selection, nonexistent IDs and processing/failed documents. Empty selection must not become all-document search. Confirm private server service-role operations still explicitly scope owner IDs.

## 5. Storage HTTP and deletion

- [ ] Verify the original-document bucket is private. Anonymous downloads and B's requests for A's object fail. A's valid signed download succeeds and expires as configured.
- [ ] Attempt owner-prefixed direct upload without an admitted reservation, foreign-prefix upload, overwrite after enqueue, and path substitution. All must fail. Reserved original upload succeeds only at the assigned path/state.
- [ ] Abort queued and active uploads; exercise expired signed upload URL, network failure, page close and resume. Confirm independent siblings continue, slots release after transport settlement, and cleanup never removes a different owner's object. An uploaded reservation can resume indexing.
- [ ] Delete in uploaded/queued/embedding/READY states. Verify document, chunks and jobs are removed according to schema, original object is removed by the application, and stale workers cannot resurrect data. Check authenticated APIs plus direct Storage/SQL state.

## 6. Queue, workers and concurrency

- [ ] Upload 1/5/10/20 mixed valid synthetic documents; record browser transport peak, global active claims, actual provider latency, RSS/CPU, retries and time to READY. Expect transport ceiling three and global claim ceiling three; do not extrapolate mocked benchmark timings.
- [ ] Add a second group during active uploads. Include duplicate content, repeated filenames with distinct content, unsupported, corrupt, oversized and OCR-only fixtures. Verify owner-scoped duplicate policy and independent visible failures.
- [ ] Run two `npm run worker` processes from the isolated configuration. Confirm shared global capacity, no duplicate live claims, lease renewals and bounded per-process concurrency. Close the browser after enqueue; independent worker/scheduler must finish.
- [ ] Temporarily reduce admission to one in the **isolated** database; race reservations/reindex operations from two sessions. Exactly one admissible operation succeeds. Restore settings and record them.
- [ ] Kill a claimed worker and wait for the 300-second lease; reclaim and attempt finalization with the old token. Expected: false/no writes. Verify max-attempt exhaustion becomes terminal and null/expired leases fail closed. Exercise lease expiry while blocked on a document row lock.
- [ ] Reindex READY documents: incomplete/new versions remain unsearchable until atomic publication; successful repeat writes do not duplicate chunks. Missing limits must reject admission.

## 7. pgvector and grounded answers

- [ ] Verify pgvector extension, halfvec(3072) embeddings and finite vectors. Query model must match stored embedding model; wrong-model/unpublished chunks must not be returned. Inspect dense and lexical RPCs separately with A/B and selected/all scopes.
- [ ] Reindex legacy PPTX parser versions below 2; deliberately reorder slide filenames in a fixture and verify displayed slide locators. Check PDF page, spreadsheet sheet and unpaginated excerpt labels without invented precision.
- [ ] Ask supported single/multi-document questions, comparisons, conflicting numeric statements, absent answers, forged quotes/citations and injected instructions. Validate every released claim/source association; no candidate text may be emitted or persisted after failed verification.
- [ ] Inject temporary 429/503 at a controlled provider boundary using synthetic evidence: recovery within budget may release only a supported verdict; exhaustion returns `AI_UNAVAILABLE` with no assistant candidate saved. Evidence-insufficient/unsupported returns the grounded refusal instead. Test caller abort during call/backoff, malformed output and timeout.
- [ ] Click citations, refresh persisted history and compare source IDs/locators and delivered/saved text. Excerpt summaries must retain the incomplete-coverage notice. Keep semantic contradiction and retrieval-budget limitations documented.

## 8. Browser acceptance and evidence/signoff

After verifying the project reference and isolated credentials, configure the two synthetic test users as required by `e2e/chat-scroll-pagination.spec.ts`:

```powershell
$env:QV_E2E_ISOLATED='1'
npm run test:e2e
Remove-Item Env:QV_E2E_ISOLATED
```

- [ ] Record passed/failed/skipped separately. The mocked tests do not constitute hosted upload acceptance. Run manual Storage/worker cases above even if Playwright passes.
- [ ] Save sanitized test outputs, migration ledger, provider metadata, worker concurrency measurements and RLS/deletion assertions with date/project reference. Remove test objects/users and revoke isolated test secrets when finished.
- [ ] Obtain release-owner signoff on every unresolved failure/risk. Only then request explicit production approval. Production prerequisites: tested restore point, maintenance window, old workers/scheduler paused, migrations before application deployment, legacy reindex plan, bounded replica count, private secrets, client-secret scan and working provider verification. No production push/migration/deployment is authorized by this checklist.
