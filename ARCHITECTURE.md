# Architecture

This document describes how QueryVault works end-to-end. For setup instructions, see [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md). For the reasoning behind key choices, see [docs/DECISIONS.md](./docs/DECISIONS.md).

---

## 1. System context

```
+-------------+
|   Browser   |
|  (React +   |
|  TanStack)  |
+------+------+
       | HTTPS
       v
+---------------------------------+
| TanStack Start (Nitro / Node)   |
| ------------------------------- |
| * Page routes                   |
| * /api/public/worker-drain      |
| * Auth, RLS-aware queries       |
+------+--------------------------+
       | Service-role (server-only)
       v
+---------------------------------+
|           Supabase              |
| ------------------------------- |
| * Postgres + pgvector           |
| * Auth (Google OAuth + email)   |
| * Storage (document uploads)    |
| * Vault (secret storage)        |
| * pg_cron + pg_net (scheduler)  |
+---------------------------------+
       |
       | HTTPS (OpenAI API)
       v
+---------------------------------+
| OpenAI text-embedding-3-large   |
+---------------------------------+
```

The browser never holds the service-role key. All privileged operations go through server-side routes that hold the key in `process.env`.

---

## 2. Ingestion pipeline

A document flows through these stages after upload:

```
User uploads PDF/DOCX
       |
       v
Supabase Storage (server-validated upload)
       |
       v
ingestion_jobs table  <-- durable queue, queued state
       |
       | (browser may trigger first drain opportunistically,
       |  but the scheduler is the source of truth)
       v
pg_cron fires every 60 seconds
       |
       v
public.trigger_ingestion_worker()
  * reads queryvault_worker_drain_url from vault.decrypted_secrets
  * reads queryvault_ingestion_worker_secret from vault.decrypted_secrets
  * if either is NULL --> RETURN false (fail-closed, no request sent)
  * if both present --> pg_net.http_post(url, headers: { x-worker-secret })
       |
       v
POST /api/public/worker-drain
  * timingSafeEqual(provided, process.env.INGESTION_WORKER_SECRET)
  * 401 if mismatch, 200 if authorized
       |
       v
drainIngestionJobs({ maxJobs: 3 })
  * SELECT ... FOR UPDATE SKIP LOCKED  (atomic claim)
       |
       v
For each claimed job:
  +--------------------------------+
  | 1. Download file from Storage  |
  | 2. Extract text                |
  | 3. Chunk with overlap          |
  | 4. Embed each chunk            |
  | 5. Insert into document_chunks |
  |    (pgvector HNSW index)       |
  | 6. Mark job completed          |
  +--------------------------------+
       |
       |  on failure: retry with exponential backoff
       v
pg_cron fires again next minute
  (cycle continues until queue empty)
```

**Browser independence:** `pg_cron` fires unconditionally every minute. Jobs arrive while no browser is connected and drain within 60 seconds. The scheduler never creates duplicate cron schedules (`IF NOT EXISTS` guard).

> In-repo note: the above describes what the migrations and code in this repository define. Whether `pg_cron`/`pg_net` are enabled and firing in a given Supabase project, and whether Vault secrets resolve there, depends on the deployed production environment and cannot be established from repository inspection alone.

---

## 3. Query pipeline

```
User asks a question
       |
       v
Embed the query (text-embedding-3-large, 3072 dims)
       |
       v
Hybrid retrieval:
  +----------------------------------------+
  |                                        |
  |  pgvector HNSW search  ---+            |
  |  (top 20 by cosine,       |            |
  |   dense floor: sim >=     |            |
  |   0.25)                   +--> RRF     |
  |                           |    fusion  |
  |  Postgres FTS search  ---+    (k = 60,  |
  |  (top 20 by ts_rank)      |  dense wt   |
  |                           |  1.0,       |
  |                           |  lexical    |
  |                           |  wt 0.8)    |
  |                                        |
  +----------------------------------------+
       |
       v
Top 12 fused chunks --> reranker:
  * LLM listwise reranker (0..1 relevance scores),
    default strategy "llm"
  * enforced timeout: the provider call is bounded by
    llmRerankerTimeoutMs (5000 ms) via a linked
    AbortController, so the in-flight provider request is
    genuinely aborted on timeout or caller cancellation
    (no fire-and-forget race)
  * deterministic heuristic fallback on timeout, provider
    error, or caller cancellation; which fallback applied
    is reported in the rerank result and telemetry
  * scores are real relevance signals, NOT
    confidence or calibrated probabilities
       |
       v
Evidence gate (runs BEFORE generation):
  * top rerank score   >= 0.35
  * top similarity     >= 0.30
  * >= 1 supporting chunk with score >= 0.30
  * gate fails --> grounded refusal, no generation
       |
       v
Build grounded context (up to 6 sources,
3200 token budget, near-duplicate folded,
max 2 passages per page)
       |
       v
Generate answer (answer ONLY from evidence;
cite with [source_01]-style ids)
       |
       v
Citation validation (post-generation, server-side):
  * strict paragraph-level rule: every substantive block
    (paragraph, bullet/numbered item, blockquote with
    claims, substantive table row) in a non-refusal answer
    must carry at least one valid citation from this
    request's evidence set
  * unknown citation ids are output failures: answers that
    violate the rule are refused before delivery
  * validation runs BEFORE delivery and persistence, so
    delivered text === stored text
       |
       v
Response with inline citations:
  "The policy was updated in Q1 [source_01]."
```

> Correction (2026-09-22): this section previously named `text-embedding-3-small`, described a "top 10 fused → LLM prompt" flow with no reranker, and framed the evidence gate as a post-generation check ("if a claim has no citation → reject"). That was wrong. As built (see `src/lib/retrieval/config.ts`, `pipeline.ts`, `reranker.ts`, `citations.ts`, `src/routes/api/chat.ts`): the pipeline embeds with `text-embedding-3-large`, retrieves 20 dense + 20 lexical candidates, fuses them with RRF (k=60) to 12 chunks, reranks with an LLM reranker whose timeout is enforced (a linked AbortController aborts the in-flight provider request at `llmRerankerTimeoutMs` = 5000 ms, with a deterministic heuristic fallback on timeout/provider error/caller cancellation), applies the evidence gate *before* generation, builds a grounded context of up to 6 sources, and validates citations *after* generation before anything is delivered or persisted. The evidence-gate threshold (`gate.minTopRerankScore`) remains 0.35 — it was never changed (see CHANGELOG "Corrections").

The evidence gate is the part that makes this "grounded RAG" rather than "chatbot that sometimes cites things." Weak evidence turns into an honest refusal instead of an invitation to hallucinate.

---

## 4. Multi-tenant isolation

Every table that holds tenant data has Row-Level Security enabled. The RLS policies use `auth.uid()` to scope rows, and the service-role key bypasses RLS only on the server side for legitimate ingestion work.

**Verified by 32 dedicated tests** that attempt cross-tenant reads/writes and confirm they are blocked.

---

## 5. Worker authentication

The worker endpoint accepts only one auth header:

```
x-worker-secret: <INGESTION_WORKER_SECRET>
```

| Caller | How it sends |
|---|---|
| `pg_net` scheduler | Reads from `vault.decrypted_secrets`, sends as header |
| Manual ops curl | `curl -H "x-worker-secret: $INGESTION_WORKER_SECRET" ...` |
| Deep health probe | Same env var, same header |

- `timingSafeEqual` protects against timing attacks
- Missing env var --> immediate 401 (fail-closed, no fallback)
- No secret values in any log output
- Grep confirmed **zero** occurrences of `Authorization: Bearer` in the repo

---

## 6. Secret management

| Secret | Where it lives | Who can read it |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Server env (`process.env`) | Server code only |
| `INGESTION_WORKER_SECRET` | Server env + Vault | Server + pg_cron |
| `OPENAI_API_KEY` | Server env | Server code only |
| `VITE_SUPABASE_URL` | Build-time `VITE_*` | Browser (safe) |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Build-time `VITE_*` | Browser (safe, anon key) |

The `validateSupabaseConfig` boot check rejects any setup where `SUPABASE_SERVICE_ROLE_KEY` accidentally has a `VITE_` prefix.

---

## 7. Deployment topology

```
+--------------------------------------------+
|        Docker container (Node 22 slim)     |
|  ----------------------------------------  |
|  * Non-root user (uid 1000)                |
|  * .output/server/index.mjs               |
|  * HEALTHCHECK via Node fetch              |
|  * SIGTERM reaches PID 1                   |
+--------------------------------------------+
       |
       | outbound HTTPS
       v
  Supabase project (managed)
```

See [docs/DOCKER.md](./docs/DOCKER.md) for the Dockerfile breakdown and [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md) for the full go-live checklist.