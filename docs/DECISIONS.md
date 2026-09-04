# Architecture Decision Records

Short records of the choices that shaped the design. Each ADR covers *why* this choice was made and what the alternatives were.

---

## ADR-001: pg_cron + pg_net instead of an external scheduler

**Context.** Document ingestion must run as durable background work that survives browser disconnects. We need a way to fire a request every minute without standing up Redis, a worker host, or a third-party scheduler.

**Decision.** Use `pg_cron` + `pg_net` inside the Supabase Postgres project.

**Why.**
- Zero new infrastructure: pg_cron is a Supabase-supported extension.
- `pg_net.http_post` makes outbound HTTPS calls from inside Postgres.
- Vault-backed secrets mean the scheduler is fail-closed: if either secret is missing, `trigger_ingestion_worker()` returns `false` and no request is sent.
- Idempotent (`IF NOT EXISTS` guard) means re-running the migration is safe.

**Alternatives considered.**
- **Supabase Edge Functions + scheduled invocations:** workable but adds a second runtime to the project and a separate secret store.
- **External scheduler (GitHub Actions cron, cron-job.org):** would work but introduces an off-platform dependency that can leak the worker secret.
- **In-process queue (e.g. `bullmq` on a separate Redis):** real production choice, but for this project it is overkill and adds cost.

**Trade-offs.** Locked to the Postgres ecosystem. Acceptable.

---

## ADR-002: Hybrid retrieval (pgvector HNSW + Postgres FTS) over single-source

**Context.** Pure semantic search misses exact keyword matches; pure keyword search misses paraphrased intent.

**Decision.** Run both, fuse with reciprocal rank fusion (RRF), feed the top 10 fused chunks to the LLM.

**Why.**
- pgvector HNSW handles semantic similarity well at our scale.
- Postgres FTS handles exact terms, IDs, and proper nouns that embeddings flatten.
- RRF is a simple, parameter-light fusion that does not require a learned reranker.
- Both indexes live in the same database, so there is no extra infrastructure.

**Alternatives considered.**
- **pgvector only:** misses exact matches; degrades on technical vocabulary.
- **FTS only:** misses paraphrased questions; degrades on natural language.
- **Cross-encoder reranker:** better quality, but requires a hosted model and adds latency. Premature for this project.

**Trade-offs.** Slightly more retrieval latency than single-source. Acceptable for the quality gain.

---

## ADR-003: RLS-first data model over application-layer tenant checks

**Context.** This is a multi-tenant system. Tenant isolation must be correct even if application code has a bug.

**Decision.** Row-Level Security is the source of truth for tenant isolation. The application layer adds tenant scoping as a defense-in-depth measure, but is allowed to trust the database.

**Why.**
- A bug in application code cannot leak cross-tenant data if RLS rejects it.
- RLS policies are visible in the schema; reviewers can audit them.
- 32 dedicated tests verify isolation; if RLS were application-layer only, the test surface would be much bigger and easier to skip.

**Alternatives considered.**
- **Application-layer `WHERE tenant_id = ?` everywhere:** works, but every query must remember it; one missed `WHERE` clause leaks data.
- **Schema-per-tenant:** heavy, does not scale, hard to migrate.

**Trade-offs.** Slight overhead per query. Acceptable.

---

## ADR-004: Fail-closed scheduler (no request if Vault secrets missing)

**Context.** A scheduler that silently "works" with no auth when secrets are missing is a security hole. A scheduler that crashes when secrets are missing is brittle.

**Decision.** `trigger_ingestion_worker()` reads Vault secrets at call time. If either is `NULL`, it returns `false` and sends no request. The cron job keeps firing, the worker keeps draining the moment both secrets appear.

**Why.**
- No "secret missing ? request sent unauthenticated" failure mode.
- No "secret missing ? exception ? cron job disabled" mode either.
- The worker endpoint itself is also fail-closed: missing `INGESTION_WORKER_SECRET` env var ? immediate 401, no fallback path.

**Alternatives considered.**
- **Fail-open with a warning:** rejected. A scheduler that fires unauthenticated requests even "occasionally" is a footgun.
- **Hard fail on missing secret:** rejected. Makes the system unusable during the window between Vault setup and first cron tick.

**Trade-offs.** The system silently does nothing if misconfigured. Mitigated by the smoke test in the deployment checklist.

---

## ADR-005: Timing-safe worker auth over plain string comparison

**Context.** Worker auth uses a shared secret. Plain `===` comparison is vulnerable to timing attacks: an attacker can measure response times to leak the secret one byte at a time.

**Decision.** Use a constant-time comparison to compare the provided secret against `process.env.INGESTION_WORKER_SECRET`.

**Why.**
- The function compares in constant time regardless of where the first mismatch is.
- It is the standard primitive for this exact problem.
- The cost is minimal; the benefit is removing a class of attack.

**Alternatives considered.**
- **`===` comparison:** simpler, but leaves a timing oracle.
- **HMAC challenge-response:** overkill for a same-secret same-process auth.

**Trade-offs.** None worth weighing.

---

## ADR-006: Service-role key server-only, validated at boot

**Context.** The `SUPABASE_SERVICE_ROLE_KEY` bypasses all RLS. If it leaks into the browser bundle, multi-tenant isolation is broken.

**Decision.**
- The key is read only in `.server.ts` files via `process.env`.
- `validateSupabaseConfig` rejects any setup where the key has a `VITE_` prefix.
- `collectBootFindings` redacts the key in diagnostic output.
- Dedicated test cases verify both controls.

**Why.**
- Browser bundles are public. Any value inlined into a `VITE_*` variable is visible to anyone who loads the page.
- A service-role key in the browser defeats every RLS policy in the entire database.
- Boot-time validation means a misconfigured deployment fails loudly before serving traffic, not silently after a tenant data leak.

**Alternatives considered.**
- **Document-only convention ("don't put it in VITE_"):** inadequate. Conventions are forgotten; automated checks are not.
- **Separate service for admin ops:** valid at larger scale, overkill here.

**Trade-offs.** Slightly more validation logic at boot. Acceptable — it runs once, not per-request.
