# Phase 4 provider recovery and live acceptance

Verdict: **BLOCKED**. The configured model exists, but the live support-verification availability prerequisite failed. The owner confirmed that no isolated Supabase project or alternative Gemini model is designated/approved. Production and development Supabase resources were not modified. No push or deployment occurred.

## Confirmed configuration and compatibility

The active environment selects Gemini and has no model or endpoint overrides. Both answer generation and support verification therefore use `gemini-3.8-flash`; utility work uses that model too. Embeddings use `gemini-embedding-001`, 3072 dimensions. No independent verifier model/fallback exists in the current integration. Other providers appearing in source code are capabilities, not approval to use them. The owner explicitly declined automatic alternative-model selection.

Official [Gemini 3.8 model documentation](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash) lists a stable text-output model, generate-content capabilities, structured outputs and thinking levels low/medium/high. The configured low level is compatible; minimal is not used. The application contract remains exact `SUPPORTED` or `UNSUPPORTED` text with structured internal outcome metadata, not a provider JSON schema. The output cap remains 256, total verifier budget 15 seconds, at most three transient attempts, and two active process-local slots. Truncated/malformed output never passes.

The authenticated model-metadata GET returned **HTTP 200 in 485 ms**, listing generateContent, countTokens, createCachedContent and batchGenerateContent, 1,048,576 input-token and 65,536 output-token limits. Model metadata availability is not successful inference acceptance. See [sanitized model evidence](phase4/model-metadata.json).

## Controlled live result and root-cause limits

One verifier availability invocation used only the known synthetic notice-period fixture and the existing configured key/model. Its bounded retry policy attempted three requests; the final result was **HTTP 503, UNAVAILABLE, provider_unavailable, supported=false, 8232 ms verifier duration** (8233 ms harness duration). No usable retry guidance was observed. No user documents or extra uncited passages were sent. [Sanitized live evidence](phase4/live-verifier.json).

The supported-claim assertion failed. The harness now records that failure and stops before the fabricated-claim request. Provider unavailability is never credited as successful rejection of an unsupported answer. No further inference probes or alternate models were used.

Confirmed: model support and compatible configured features; current inference returns a provider-unavailable classification; prior direct SDK-free probes also returned capacity/high-demand signals. Not confirmed: Google's internal cause, the project's remaining quota, billing standing or whether quota/capacity contributes to this specific request. No 429 was observed, but that alone cannot rule quota effects out. [Official rate-limit documentation](https://ai.google.dev/gemini-api/docs/rate-limits) says limits are per project and active limits are visible in AI Studio; an API key/model metadata response does not provide those counters. [Troubleshooting guidance](https://ai.google.dev/gemini-api/docs/troubleshooting) recommends bounded backoff for transient failures; existing retries were preserved.

## Contract acceptance matrix

| Case | Live status | Existing deterministic regression coverage |
| --- | --- | --- |
| Fully supported answer | **Failed availability prerequisite: 503** | Supported verdict releases associated evidence only |
| Fabricated claim | Not run after prerequisite failed | UNSUPPORTED rejects; failure does not persist candidate |
| Partially supported answer | Blocked by unavailable verifier | Claim/block/coverage checks exist; no live entailment quality claim |
| Inaccurate quotation | Blocked for full live workflow | Exact quotation mismatch rejected before provider |
| Incorrect citation | Blocked for full live workflow | Unknown/out-of-scope citation rejected |
| Conflicting information | Blocked for full live workflow | Local numeric-conflict report cites both sources; semantic conflict coverage remains incomplete |
| Insufficient evidence | Blocked for full live workflow | Retrieval gate and grounded refusal covered |
| Malformed provider response | No live fault injection | Mocked malformed/truncated verdict fails closed |
| Provider timeout | No additional live timeout probe | Mocked deadline, delayed-timer and cancellation tests pass |
| Provider unavailable | **Observed 503; no verified answer released** | Retry recovery/exhaustion and API 503/no-persistence covered |

Mocked verdicts exercise application handling, not actual model accuracy. There is no reported live accuracy/citation score while the prerequisite fails.

## Isolated Supabase and documents

No dedicated hosted test project is designated. The owner prohibited destructive testing on production **and development** projects. Accordingly, hosted migrations, Auth/Storage operations, deletion/reindex tests and live ingestion were not run. Disposable local SQL regression checks are separate from hosted acceptance: they use network-disabled Docker Postgres/pgvector with no host bind mounts, no `.env` access and a generated database that is dropped after the run. Auth/Storage are SQL scaffolding and the scheduler/Vault/cron/net migration is not tested there.

`node scripts/prepare-phase4-fixtures.mjs` prepares 20 synthetic UTF-8 files with immutable hashes, batches of 1/5/10/20 and ground-truth single-document, cross-document, conflicting-policy, absent-answer, selected-scope and exact-quote questions. Output: `.verification/phase4-corpus`. [Ground-truth manifest](phase4/ground-truth.json). The files are prepared, **not ingested**. Live embedding/indexing, ingestion-to-READY, first validated response, full response latency, citation accuracy and cost measurements are **not available**. Earlier simulated fixture benchmarks are not reused as real throughput.

## Safe fixes and regression results

- The live test now stops immediately after a failed supported-claim availability prerequisite, preserves sanitized evidence, and retains its original success/rejection assertions.
- The disposable SQL test harness now waits a bounded number of readiness polls before createdb. Its first Phase 4 run failed during container initialization (missing Postgres socket); this was a harness startup race, not a passed SQL check.
- The fixture generator performs only local writes, no network/database/provider operations. Architecture, model selection, output contract, privacy limits, retries and fail-closed behavior remain unchanged.

| Check | Actual result |
| --- | --- |
| `npm test -- --configLoader native --maxWorkers 1` | 537 passed, 2 opt-in live tests skipped; 32 files passed, 1 skipped |
| `npx tsc --noEmit` | Passed |
| `npm run lint` | Zero errors, 14 warnings |
| `npm run eval:gate` | Existing retrieval gate and 12 safety checks passed |
| `npm run build` | Passed |
| `npm run security:client` | No configured private key values in public artifact |
| `npm run test:e2e` | 2 passed, 1 hosted-write test skipped; 43.6 seconds |
| `npm run test:db` (disposable Docker only) | 13 passed after bounded startup readiness fix; [SQL evidence](phase4/local-database.json) |
| Separately enabled live verifier | 1 failed; 503 UNAVAILABLE; remaining live cases not run |
| Hosted isolated Supabase / real-document acceptance | Blocked, not run |

 The separately enabled live verifier is **failed**, not skipped. Default opt-in skips and hosted-write browser skips are reported separately.

## Exact manual actions to unblock acceptance

1. In the Gemini project's [AI Studio active rate limits](https://aistudio.google.com/usage?timeRange=last-28-days&tab=rate-limit), inspect the intended model's RPM/TPM/RPD, quota exhaustion, billing standing and project restrictions. Check [provider status](https://aistudio.google.com/status). Do not enable paid capacity or switch providers automatically. Record sanitized observations; no keys in chat or logs.
2. When healthy, run the supported availability prerequisite once using the existing configured model. If an alternative is desired instead, explicitly approve its exact ID after capability/privacy review; none is currently approved. Do not raise the deadline or bypass verification merely to obtain a pass.
3. Create a **new**, dedicated test-only Supabase project (suggested name `queryvault-acceptance`) in [Supabase Dashboard](https://supabase.com/dashboard). Choose the organization/region and review any plan/cost implications yourself; this task did not enable paid services. Do not clone production data. Record its distinct project reference and explicitly designate it for destructive synthetic tests.
4. In the new project's Connect/API Keys settings, obtain its URL, browser publishable/anon key and server-only service-role credential required by this app. Keep credentials in a separate ignored `.env` in a separate checkout/configuration directory; never paste secret values into chat. Copy `.env.example` as the starting template and replace **all** Supabase URL/ref/key fields with test-project values. Keep Gemini configuration unchanged, set a fresh worker secret and `QV_TRACE_CONTENT=0`. See [Supabase keys guidance](https://supabase.com/docs/guides/getting-started/api-keys). Configure two synthetic test users and local redirect URLs.
5. Once that project is explicitly designated, follow [ISOLATED_SUPABASE_ACCEPTANCE.md](ISOLATED_SUPABASE_ACCEPTANCE.md) for migrations, private Storage, Auth, RLS, workers, leases, deletion, pgvector, reindexing and cancellation. Do not set `QV_E2E_ISOLATED=1` in the current workspace to turn existing credentials into test authorization.
6. Run the prepared prefix batches from a clean synthetic corpus state, retain upload-to-READY and per-stage embedding/index timings, ask every applicable ground-truth question and inspect delivered/persisted citation IDs and authentic locators. Record unavailable responses separately from incorrect answers and refusals. Complete all ten live contract cases only after supported verification works; use controlled test-boundary injection for malformed/error cases rather than trying to break Google's service.
7. Production remains gated on these live results, backup/restore testing, remaining dependency-risk review, worker/replica limits and explicit approval. No production migration, push or deployment is authorized by this report.
