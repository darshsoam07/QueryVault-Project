# Phase 5: strict zero-cost acceptance

Continuation: [Phase 6 local readiness](PHASE6_LOCAL_READINESS.md) records passing saved-history refresh/browser acceptance and the explicit local-only boot-validation fix. Phase 5 results below are historical; the ₹0/no-download restrictions remain in force.

Reviewed 16 October 2026 (Asia/Calcutta). **Verdict: BLOCKED for live AI/full Supabase acceptance; local deterministic development is available.** No billing, paid services, new cloud resources, model changes, hosted writes, push or deployment. No CLI, container images or model weights downloaded. No new Gemini inference/embedding requests were made in Phase 5. Earlier live results are historical, not proof of free-tier eligibility.

## A. Zero-cost architecture

Preserve the root TanStack/React application, local extraction/chunking, durable Postgres queue, pgvector/full-text retrieval and strict citation/support verification. The intended no-service-fee deployment is on existing hardware: local Supabase Auth/Storage/Postgres plus an explicitly approved, validated local inference/embedding runtime. Neither the local AI runtime nor the complete Supabase stack is currently installed/accepted. The separate `local-stack` demo uses a different backend/vector store and was not substituted for QueryVault.

Implemented `npm run dev:zero-cost`, `config/zero-cost.env.example`, local endpoint guards and regression tests. The launcher requires a separate ignored `.env.zero-cost.local`, validates loopback URLs, forces `QV_LOCAL_ONLY=1`/`VITE_QV_LOCAL_ONLY=1`, disables live tests/private trace text, and clears provider keys in the child environment. In that profile all AI resolution, SDK construction, utility calls, embedding calls and direct support verification fail closed before inference. Supabase fetches reject non-loopback destinations and forbid redirect-following. No semantic verifier is replaced with keyword matching; AI-disabled documents cannot complete embedding-backed indexing or answer acceptance.

Scope: these are application/profile controls, not an OS network firewall or a billing-account inspection. Standard `npm run dev` and the existing `.env` remain unchanged and are **not certified zero-cost**; use only the dedicated profile for operations. Local services/proxies must themselves have no cloud forwarding. Browser fonts and installed build tools are not blocked by a general network firewall. Electricity, existing hardware and Internet access are not provisioned or billed by QueryVault; literal zero total household expenditure cannot be guaranteed.

## B. Gemini investigation

Configured generation/verifier/utility model: `gemini-3.8-flash`; embedding: `gemini-embedding-001`, width 3072. No alternate model override or approved fallback exists. The owner prohibits model/backend changes without approval.

[Official pricing](https://ai.google.dev/gemini-api/docs/pricing) documents a free inference tier for the exact chat model. [Model documentation](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash) confirms text/structured output, low thinking support, 1,048,576 input and 65,536 output-token limits. The existing v1beta generateContent configuration uses low thinking and a 256-token cap; metadata compatibility does not establish eligibility or capacity.

The latest historical Phase 4 inference invocation failed with 503 UNAVAILABLE after three bounded attempts in 8232 ms. Earlier direct REST probes showed capacity/high-demand signals. That establishes provider-reported unavailability, not Google's internal root cause or this account's quota state. No additional probes were made to test quota. [Historical evidence](phase4/live-verifier.json).

| Project-specific fact | Verified status |
| --- | --- |
| Free/unbilled account and project eligibility | Unverified |
| Actual model RPM, TPM and RPD allocations | Unverified |
| Remaining usage / quota exhaustion | Unverified |
| Billing standing | Unverified; no billing pages/settings changed |
| Current provider incident affecting this project | Unverified; public status page did not expose a readable incident list |
| Account age/verification/regional entitlement | Unverified |

No existing AI Studio tab was available through the enabled browser connection. The owner may provide a credential-free quota/tier readout. [Rate-limit documentation](https://ai.google.dev/gemini-api/docs/rate-limits) directs users to active project limits rather than a guaranteed universal RPM/RPD table. Do not invent limits from old blog posts or infer remaining quota from a successful model GET. [Region documentation](https://ai.google.dev/gemini-api/docs/available-regions) includes India but actual account, age/verification and serving-region eligibility remain unverified. Live tests are **BLOCKED**, not passed.

The exact embedding model had a [documented free-access launch](https://developers.googleblog.com/en/gemini-embedding-available-gemini-api/), but this is not current project entitlement. The current pricing page emphasizes newer embeddings; no model migration or assumption that embedding-001 is currently free for this account was made.

## C. Free model candidates (researched, not activated)

| Exact ID | Published standard free inference | Input/output token limits | Project RPM/TPM/RPD and remaining quota | Contract/API fit | Decision |
| --- | --- | --- | --- | --- | --- |
| `gemini-3.8-flash` | Documented | 1,048,576 / 65,536 | Unverified | Existing Gemini integration; low thinking; structured output supported | Keep selection unchanged; live blocked |
| `gemini-2.5-flash-lite` | Documented | 1,048,576 / 65,536 | Unverified | Same generateContent integration; current 2.5 thinkingBudget path; structured output supported | Small candidate for synthetic entailment evaluation only after approval/eligibility confirmation |
| `gemini-2.5-flash` | Documented | 1,048,576 / 65,536 | Unverified | Same API and binary verdict contract; structured output supported | Candidate if smaller model quality is inadequate; not approved/tested |

Sources: [pricing](https://ai.google.dev/gemini-api/docs/pricing), [Flash-Lite capabilities](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-lite), [Flash capabilities](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash). No candidate currently has **confirmed account-specific** free-tier capacity. Batch/flex/cache/grounding options are not assumed free and are not enabled. The runtime contract is exact SUPPORTED/UNSUPPORTED text with structured internal metadata, not a provider JSON schema.

Privacy: [Gemini unpaid-service terms](https://ai.google.dev/gemini-api/terms) allow submitted content/output to be used for improvement and human review, and prohibit sending sensitive/confidential/personal information to unpaid services. Regional exceptions exist. Therefore these candidates are for non-sensitive synthetic evaluation only until privacy requirements are satisfied; free cloud access is not an equivalent replacement for private local processing. No private document disclosure was expanded.

## D. Local AI feasibility

Observed hardware: 15.68 GiB physical RAM, 12 logical processors, Intel Core i5-1235U; Intel Iris Xe integrated graphics (approximately 2 GiB reported adapter memory, not proof of dedicated usable VRAM). About 223.6 GiB free on C: at inspection. Docker 29.7.2 is installed; Supabase CLI and Ollama were not found on PATH. No inference speed or model accuracy was measured.

The existing `openai-compatible` provider and [Ollama OpenAI-compatible endpoints](https://docs.ollama.com/api/openai-compatibility) make a local adapter feasible without rewriting RAG. Approval would be needed to select models/backend; local model output still needs the exact verifier verdict, associated evidence only, finish-reason checks, deadline, cancellation, bounded concurrency and the complete adversarial/unsupported-claim suite. API compatibility is not quality equivalence.

A concrete evaluation candidate is [Ollama `qwen3:4b`](https://ollama.com/library/qwen3:4b): Q4_K_M, about 2.5 GB model weights, Apache-2.0 ([upstream license](https://huggingface.co/Qwen/Qwen3-4B/blob/main/LICENSE)). RAM also includes context/KV cache, runtime, OS, database and other services; the download size is not a RAM requirement. A small quantized model may fit, but CPU inference and concurrent contexts may exceed the existing 15-second budget. Start with one local request when approved, measure cold/warm latency and quality, and do not claim parity or increase deadlines without measurements. No model/runtime installation occurred. Disable Ollama cloud features with `OLLAMA_NO_CLOUD=1`, keep loopback bindings, and never select cloud-tagged models ([official FAQ](https://docs.ollama.com/faq)).

Local embedding candidate [Qwen3-Embedding-0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) is Apache-2.0 and supports up to 1024 dimensions; Ollama's [Q8_0 package](https://ollama.com/library/qwen3-embedding:0.6b) is about 639 MB. It **cannot fill the existing halfvec(3072) schema**. Adoption requires an approved forward schema/RPC/index/type/dimension migration, re-embedding every document, query/document model consistency, threshold calibration and retrieval evaluation. Do not pad vectors, mix model spaces, or reuse old vectors. An 8B model supports wider embeddings but has larger memory/cost-to-run constraints; it is not installed or selected. No embedding migration was made.

## E. Supabase local acceptance

Existing `supabase/config.toml` was inspected and preserved. `node scripts/prepare-local-supabase.mjs` prepared `.verification/supabase-zero-cost` with a distinct local project ID, copied migrations/templates, loopback app redirects and analytics disabled. It refuses overwrite and does not install, start, link, reset or push anything. Scheduler Vault URL/secret remain unset, so scheduled wakeups cannot target hosted services.

The owner explicitly chose **setup only; no downloads**. Complete local Auth/Storage/PostgREST/Vault/scheduler acceptance is therefore blocked: required CLI/images are absent. Preparation is not a successful stack start or migration test.

The cached pgvector image was used with `--pull=never`, no network, no host bind mounts and disposable generated databases. Auth/Storage roles/schemas were scaffolding, not actual HTTP services. Thirteen real SQL checks passed after correcting a startup race: readiness now checks final TCP availability rather than the temporary initialization socket. The first Phase 5 run failed with a shutting-down server and is not reported as passed. Full scheduler migration remains excluded by the existing SQL harness.

| Area | Actual acceptance |
| --- | --- |
| Core migrations, pgvector, atomic admission, global concurrent claims | Passed on disposable real PostgreSQL |
| Lease fencing/reclaim/exhaustion, deletion and reindex publication | Passed on disposable real PostgreSQL |
| SQL ownership/RLS and reservation-bound Storage policies | Passed using scaffolded roles/tables |
| Auth login/refresh/email, signed Storage upload/download HTTP | Not run; full local stack absent |
| Real provider-backed workers / end-to-end 1/5/10/20 documents | Blocked; AI disabled and full local stack absent |
| Retry, cancellation, citations and browser workflows | Deterministic/mocked coverage; not live provider acceptance |

After explicit download approval (not granted now), install an official pinned CLI, inspect image/disk requirements, then run `supabase start --workdir .verification/supabase-zero-cost`. Verify loopback service bindings before use; never `supabase link`, hosted `db push`, or reset a hosted project. Obtain local-only keys into ignored `.env.zero-cost.local`, then `npm run dev:zero-cost`. This profile still blocks AI until a separately approved local adapter is implemented/accepted. Adapt [ISOLATED_SUPABASE_ACCEPTANCE.md](ISOLATED_SUPABASE_ACCEPTANCE.md) to local-only endpoints, two disposable users and synthetic files.

## F. Cost audit

| Dependency/path | Classification | Control / qualification |
| --- | --- | --- |
| PDF, Office, TXT parsing; hashing/chunking; pgvector/FTS | Fully local | Existing libraries; no paid OCR/document intelligence |
| Local Postgres/Docker SQL tests | Fully local | Cached image, pull never, network none; [Docker permits personal/education use](https://docs.docker.com/subscription-billing/desktop-license/) |
| Complete local Supabase/Auth/Storage | Fully local, prepared only | Tools/images not installed; no download approval |
| Gemini chat/verifier/utility | Documented free but quota-limited; actual account unknown | Disabled in local profile; no live requests |
| Gemini embeddings | Unknown current account entitlement | Disabled; no request/model change |
| Ollama/Qwen local inference/embedding | Local proposal, not activated | Download/backend/model approvals and quality acceptance needed |
| Existing hosted Supabase DB/Auth/Storage/telemetry | Unknown account plan/usage | Untouched; local profile rejects remote fetches |
| OpenAI, Lovable AI gateway, arbitrary remote compatible endpoints | Paid/unknown and prohibited | No fallback activation; local profile disables AI |
| Google Fonts stylesheet/font CDN | Public free service, network-dependent | Existing app dependency; no key/subscription; not fully offline |
| Application telemetry/error reporting | Same configured DB/local app logs | Private text off; no external analytics service found in application source |
| npm/Bun/Vite/Playwright, model/image registries | Installed local tools; downloads can use bandwidth | Existing installations/caches only; no installation/download made |
| App hosting/CDN/domain, paid OCR, third-party vector DB | Not provisioned; paid services prohibited | Existing laptop loopback deployment only |

Retries can consume quota; verifier remains at most three attempts/15 seconds/two process-local slots with shared cooldown, embedding concurrency two and global ingestion claims three. These are capacity controls, not proof of a ₹0 account. No automatic provider/model fallback was found. Deep health probes can send embedding requests outside the local profile, so they are prohibited until entitlement is verified; local profile resolution blocks them.

[Supabase's published Free plan](https://supabase.com/pricing): 500 MB database, 1 GB file storage, 5 GB egress plus 5 GB cached egress, shared CPU/500 MB RAM, 50,000 MAU, two active projects, pause after one inactive week. These are plan terms, not this account's remaining resources. Paid compute/add-ons, additional paid projects, custom domains, PITR and paid-plan overages are prohibited. A small demo may fit, but vector/HNSW/text/row storage and repeated downloads must be measured; the 200 MiB pending-upload limit is not a total-vault cap. Supabase does not provide the long-running QueryVault application host. Local development is preferred; no hosted resource was created.

## G. Test results

| Check | Actual execution / category |
| --- | --- |
| Final unit suite | 550 passed, 2 opt-in live tests skipped; 33 files passed, 1 skipped; local/mocked |
| TypeScript | Passed, including final check after the transport integration regression |
| ESLint | Zero errors, 14 warnings; local tooling |
| RAG evaluation | Existing thresholds and 12 deterministic safety checks passed; local fixtures |
| Production build / private client-secret scan | Passed; local artifact, no inference |
| SQL integration suite | 13 passed after startup fix; real local PostgreSQL/pgvector |
| Playwright initial run | 2 failed with 30-second timeouts, 1 hosted-write test skipped; mocked boundaries |
| Playwright final independent run | 1 passed (multi-document), 1 failed (saved-citation/scroll hydration timeout), 1 hosted-write test skipped; assertions/timeouts unchanged |
| Guarded launcher with missing local configuration | Expected refusal/exit 1 before server startup |
| Verified-free inference / verified-free embeddings | Not run; BLOCKED by unverified account/quota |
| Full local Supabase Auth/Storage/scheduler | Not run; setup only, downloads declined |

[SQL evidence](phase5/local-database.json). Initial browser timeouts occurred at hydration and batch completion while other checks were running. The independent rerun still timed out during saved-history hydration before citation/scroll assertions executed, while the 20-document browser test passed. Resource contention/cold-start compilation remain hypotheses; the browser issue is unresolved and blocks browser acceptance. No timeouts/assertions were increased or disabled. Unit/browser provider responses are mocked; SQL checks use local real infrastructure; unavailable historical external checks are not promoted to passing results.

The dedicated launcher was executed without `.env.zero-cost.local`: it exited 1 before starting Vite, requiring local configuration instead of falling back to hosted `.env`. This is an expected negative cost-safety check, not a successful application start.

Live tests now require both `RUN_LIVE_GEMINI_TESTS=1` and `QV_CONFIRMED_FREE_TIER=1`, and refuse local-only mode. The second flag is a documented operator attestation after read-only eligibility/quota confirmation, not automated billing verification or permission to use paid resources. Do not set it now. Synthetic fixture selection and failure-stop behavior remain unchanged.

## H. Production limitations

Saved-history browser hydration also remains a failed acceptance check; investigate the timeout before release. Passing unit tests do not supersede this failure.

An incremental-service-fee-free local development workflow is practical. A functioning private, fully local RAG deployment is **not yet accepted**: complete Supabase services are absent, AI remains disabled, model quality/deadline compliance is unmeasured, and local embedding compatibility requires a deliberate migration. Hosted free tiers offer no permanent capacity/availability guarantee and current account quotas are unknown. No zero-hallucination or production-throughput claim is made. Existing moderate/low dependency advisories still require review; no packages were upgraded or downloaded in this phase.

## I. Required approvals and next actions

1. No further provider calls until a credential-free tier/quota readout establishes free eligibility and available limits for the exact account/models. No billing enablement, promotional-credit workaround or paid fallback.
2. CLI/container downloads were declined. Keep prepared setup only until the owner explicitly changes that instruction. Then validate full local Auth/Storage/RLS/queue workflows using disposable accounts and fixtures.
3. Any local runtime/model download, model/backend activation, local embedding schema migration or alternative Gemini model requires explicit approval. `qwen3:4b` and `qwen3-embedding:0.6b` are evaluated proposals, not approved replacements.
4. Local code/profile creation is complete; active `.env`, backend/model selection and repository Supabase configuration remain unchanged. Use only the guarded profile once real local credentials exist. Do not use ordinary hosted development commands under the ₹0 constraint.
5. No hosted deployment, push, resource provisioning or billing changes. Full readiness remains BLOCKED until the missing local/free eligibility and quality acceptance requirements pass.
