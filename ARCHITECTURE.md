# Architecture

This document describes how QueryVault works end-to-end. For setup instructions, see [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md). For the reasoning behind key choices, see [docs/DECISIONS.md](./docs/DECISIONS.md).

---

## 1. System context

```
+-------------+
¦   Browser   ¦
¦  (React +   ¦
¦  TanStack)  ¦
+-------------+
       ¦ HTTPS
       ?
+---------------------------------+
¦  TanStack Start (Nitro / Node)  ¦
¦  -----------------------------  ¦
¦  • Page routes                  ¦
¦  • /api/public/worker-drain     ¦
¦  • Auth, RLS-aware queries      ¦
+---------------------------------+
       ¦ Service-role (server-only)
       ?
+---------------------------------+
¦           Supabase              ¦
¦  -----------------------------  ¦
¦  • Postgres + pgvector          ¦
¦  • Auth (Google OAuth + email)  ¦
¦  • Storage (document uploads)   ¦
¦  • Vault (secret storage)       ¦
¦  • pg_cron + pg_net (scheduler) ¦
+---------------------------------+
       ¦
       ¦ HTTPS (OpenAI API)
       ?
+---------------------------------+
¦  OpenAI text-embedding-3-small  ¦
+---------------------------------+
```

The browser never holds the service-role key. All privileged operations go through server-side routes that hold the key in `process.env`.

---

## 2. Ingestion pipeline

A document flows through these stages after upload:

```
User uploads PDF/DOCX
       ¦
       ?
Supabase Storage (server-validated upload)
       ¦
       ?
ingestion_jobs table  ? durable queue, queued state
       ¦
       ¦ (browser may trigger first drain opportunistically,
       ¦  but the scheduler is the source of truth)
       ?
pg_cron fires every 60 seconds
       ¦
       ?
public.trigger_ingestion_worker()
  • reads queryvault_worker_drain_url from vault.decrypted_secrets
  • reads queryvault_ingestion_worker_secret from vault.decrypted_secrets
  • if either is NULL ? RETURN false (fail-closed, no request sent)
  • if both present ? pg_net.http_post(url, headers: { x-worker-secret })
       ¦
       ?
POST /api/public/worker-drain
  • timingSafeEqual(provided, process.env.INGESTION_WORKER_SECRET)
  • 401 if mismatch, 200 if authorized
       ¦
       ?
drainIngestionJobs({ maxJobs: 3 })
  • SELECT ... FOR UPDATE SKIP LOCKED  (atomic claim)
       ¦
       ?
For each claimed job:
  +--------------------------------+
  ¦ 1. Download file from Storage  ¦
  ¦ 2. Extract text                ¦
  ¦ 3. Chunk with overlap          ¦
  ¦ 4. Embed each chunk            ¦
  ¦ 5. Insert into document_chunks ¦
  ¦    (pgvector HNSW index)       ¦
  ¦ 6. Mark job completed          ¦
  +--------------------------------+
       ¦
       ¦  on failure: retry with exponential backoff
       ?
pg_cron fires again next minute
  (cycle continues until queue empty)
```

**Browser independence:** `pg_cron` fires unconditionally every minute. Jobs arrive while no browser is connected and drain within 60 seconds. The scheduler never creates duplicate cron schedules (`IF NOT EXISTS` guard).

---

## 3. Query pipeline

```
User asks a question
       ¦
       ?
Embed the query (OpenAI)
       ¦
       ?
Hybrid retrieval:
  +----------------------------------------+
  ¦                                        ¦
  ¦  pgvector HNSW search --+             ¦
  ¦  (top 20 by cosine)     ¦             ¦
  ¦                         +-? RRF fusion¦
  ¦  Postgres FTS search  --+             ¦
  ¦  (top 20 by ts_rank)                  ¦
  ¦                                        ¦
  +----------------------------------------+
       ¦
       ?
Top 10 fused chunks ? LLM prompt
       ¦
       ?
Evidence gating:
  • LLM must cite at least one chunk ID
  • Each cited chunk must actually appear in the retrieved set
  • If a claim has no citation ? reject the response
       ¦
       ?
Response with inline citations:
  "The policy was updated in Q1 [doc:handbook.pdf, chunk:42]."
```

The evidence gate is the part that makes this "grounded RAG" rather than "chatbot that sometimes cites things." Ungrounded answers are rejected before they're shown to the user.

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
- Missing env var ? immediate 401 (fail-closed, no fallback)
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
¦        Docker container (Node 22 slim)     ¦
¦  --------------------------------------    ¦
¦  • Non-root user (uid 1000)                ¦
¦  • .output/server/index.mjs               ¦
¦  • HEALTHCHECK via Node fetch              ¦
¦  • SIGTERM reaches PID 1                   ¦
+--------------------------------------------+
       ¦
       ¦ outbound HTTPS
       ?
  Supabase project (managed)
```

See [docs/DOCKER.md](./docs/DOCKER.md) for the Dockerfile breakdown and [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md) for the full go-live checklist.
