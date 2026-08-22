# QueryVault

A multi-tenant RAG (Retrieval-Augmented Generation) document assistant. Upload PDFs, ask questions, get streamed answers grounded in your own documents with page-level citations — or an honest refusal when the documents don't actually contain the answer.

## What it is

A private knowledge base with a chat interface in front of it. You upload documents; they are parsed, chunked, embedded, and indexed. You ask a question in natural language; the system retrieves the passages that actually bear on it and answers from those passages alone, citing each claim back to the source it came from.

Every tenant sees only their own documents, enforced at the database level rather than in application code.

## Problem it solves

A general-purpose language model doesn't know what's in your contracts, your research notes, or last quarter's reports — and when asked about them it will often produce a fluent, confident, wrong answer. Naive RAG improves on that but inherits the same failure mode: retrieve *something*, hand it to the model, hope the answer is grounded.

QueryVault was built to explore the part most RAG tutorials skip: **how do you stop the system from confidently answering when it shouldn't?**

Three mechanisms address it directly:

- an **evidence gate** that runs *before* generation and refuses outright when retrieval is too weak — no LLM call, so no opportunity to improvise
- **server-side citation validation**, so the model cannot invent a source that was never retrieved
- a **CI-gated evaluation harness** measuring retrieval quality, refusal accuracy, and prompt-injection resistance, so a regression fails the build rather than shipping quietly

This is *grounded generation*, not a hallucination-free guarantee. No such guarantee exists, and claiming one would be the same overconfidence the design is trying to avoid.

## Core features

- **Document ingestion** — PDF upload with content-type and magic-byte validation, page-aware chunking, batched embedding, HNSW indexing
- **Hybrid retrieval** — dense vector search plus Postgres full-text search, fused with Reciprocal Rank Fusion, then reranked
- **Grounded answering** — pre-generation evidence gate, streamed responses, page-level citations validated server-side
- **Honest refusal** — a fixed refusal when the corpus doesn't support an answer, rather than a plausible guess
- **Multi-tenant isolation** — RLS on every table, re-asserted independently inside the retrieval functions
- **Durable ingestion queue** — crash-safe job processing with `FOR UPDATE SKIP LOCKED`, deterministic chunk ids, exponential backoff, dead-worker lock reclaim
- **Built-in observability** — structured telemetry, per-query retrieval traces, health endpoints, request-id correlation
- **Evaluation harness** — offline golden-set scoring, runnable with no API key and no network

## Architecture

```
                          User (browser)
                                │
                                ▼
                  React 19 / TanStack Start (SSR)
                                │
                                ▼
            ┌───────── Application server (Node) ─────────┐
            │  API routes  ·  server functions  ·  worker │
            └─────────────────────┬───────────────────────┘
                                  │
        ┌──────────────┬──────────┼───────────────┬──────────────────┐
        ▼              ▼          ▼               ▼                  ▼
  Supabase Auth   PostgreSQL   Supabase       Embedding           LLM
    (GoTrue)          │         Storage        provider          provider
                      │        (private,     (server-only)     (server-only)
        ┌─────────────┴─────────┐  owner-
        ▼          ▼            ▼  scoped)
    pgvector     HNSW      Row Level
   halfvec(3072) index      Security
```

Request paths:

```
Upload ─► validate ─► Storage (per-user path) ─► durable job queue (SKIP LOCKED)
                                                        │
                                    parse ─► chunk ─► embed ─► index
                                                        │
                                                  status: indexed

Chat ──► auth ─► rate limit ─► retrieval ─► evidence gate ─┬─ pass ─► LLM (streamed)
                                    │                      │            │
                        dense + lexical → RRF → rerank     │      cite validation
                                                           └─ fail ─► refusal
                                                                    (no LLM call)
```

It is a **modular monolith**, deliberately. One deployable process, clear module boundaries, no service mesh. The queue is a Postgres table, not a broker. At this scale that is the correct trade: a distributed system's failure modes would cost far more than they would buy.

## Tech stack

| Layer | Choice |
|---|---|
| Framework | TanStack Start (SSR) + TanStack Router |
| UI | React 19, Tailwind CSS, Radix primitives |
| Server | Nitro (`node-server` preset) |
| Database | PostgreSQL via Supabase |
| Vector search | pgvector — `halfvec(3072)`, HNSW, cosine |
| Lexical search | Postgres full-text search |
| Auth | Supabase Auth (GoTrue), JWT |
| Storage | Supabase Storage (private bucket) |
| AI | OpenAI by default; Lovable Gateway or any OpenAI-compatible endpoint |
| Validation | Zod |
| Tests | Vitest |
| Build | Vite 8 (rolldown) |

## RAG pipeline

1. **Query rewriting** — the raw question is normalised into a retrieval query. Conversational phrasing retrieves badly.
2. **Dense retrieval** — cosine similarity over `halfvec(3072)` embeddings, HNSW-indexed.
3. **Lexical retrieval** — Postgres FTS in parallel. Catches exact identifiers, product codes, and rare terms that embeddings smooth over.
4. **Reciprocal Rank Fusion** — merges both lists by *rank*, not score. Cosine similarity and `ts_rank` are not on comparable scales; averaging them directly is a category error.
5. **Reranking** — an LLM listwise reranker scores the fused candidates, with a deterministic heuristic fallback if that call fails. Retrieval degrades; it does not break.
6. **Evidence gate** — checks top rerank score and supporting-chunk count. Below threshold, the system returns a fixed refusal **without calling the LLM at all**. This is the load-bearing step: a model handed weak context will still produce an answer.
7. **Context assembly** — token-budgeted, so the prompt cannot overflow and silently truncate the evidence the answer depends on.
8. **Generation** — streamed, with evidence framed as untrusted reference data (see [Security model](#security-model)).
9. **Citation validation** — every `[source_NN]` marker is checked server-side against the actually-retrieved set before persistence or rendering. A citation the model invented is rejected, not displayed.

### Evaluation results

Run offline — no API keys, no network (`npm run eval`) — against a 13-case golden set spanning factual lookup, semantic paraphrase, cross-document, multi-hop, refusal (negative), and prompt-injection categories:

| Metric | Result |
|---|---|
| Recall@5 | 1.00 |
| Recall@10 | 1.00 |
| MRR | 0.925 |
| nDCG@10 | 0.950 |
| Citation validity | 1.00 |
| Refusal accuracy | 1.00 |
| False refusal rate | 0.00 |
| Injection defense | 1.00 |

`npm run eval:gate` exits non-zero if any metric drops below its floor in `evaluation/thresholds.json`.

*The eval corpus is a small fixture set (13 cases), not a large benchmark. Treat these as a regression signal, not a claim of production-scale accuracy.*

## Authentication

Supabase Auth (GoTrue) issues JWTs; the browser client persists and refreshes the session.

- **Email + password** — always available. Sign-up correctly distinguishes "signed in" from "check your email", depending on whether the project requires confirmation.
- **Google OAuth** — native Supabase `signInWithOAuth`, shown only when `VITE_ENABLE_GOOGLE_AUTH=true`. An unconfigured provider fails 100% of the time, so the button stays hidden rather than shipping broken.

Server-side, every protected path verifies the bearer token before doing anything. Two verification strategies exist deliberately:

- `requireSupabaseAuth` (server-function middleware) validates claims locally — fast, used on the hot path.
- `verifyAccessToken` (API routes) calls `auth.getUser`, which additionally confirms the account still exists and isn't banned — a network round-trip, worth it at the API boundary.

Both then operate through a **user-scoped** Supabase client carrying the caller's token, so RLS still applies. The service role key is never used to serve a user request.

## Database

Postgres, with schema in [`supabase/migrations/`](./supabase/migrations).

| Table | Holds |
|---|---|
| `documents` | Uploaded document metadata and ingestion status |
| `document_chunks` | Chunk text, page numbers, embeddings, FTS vectors |
| `threads` | Conversations |
| `messages` | Messages with validated citations |
| `profiles` | Per-user display metadata, created on sign-up by trigger |
| `user_roles` | Role assignments (`admin`, `operator`) for the operator views |
| `worker_credentials` | Hashed worker secrets for the ingestion/health endpoints |
| `ingestion_jobs` | Durable work queue with lock/attempt/failure state |
| `telemetry_events` | Structured application events |
| `query_traces` | Per-query retrieval diagnostics |
| `rate_limit_events` | Rate-limiter ledger |

All eleven tables have RLS enabled, and the user-data tables carry a `user_id` compared against `auth.uid()`. Privileged helpers (`has_role`, `is_operator`) are `SECURITY DEFINER` with a pinned `search_path` and `EXECUTE` revoked from `anon` — an unpinned search path on a function that decides authorization is a privilege-escalation vector.

The ingestion queue is a table rather than a broker: `FOR UPDATE SKIP LOCKED` gives safe concurrent claiming across replicas, locks expire so a crashed worker's jobs return to the pool, and chunk ids are derived deterministically from `(document, pipeline version, position)` so a retry upserts instead of duplicating.

## Vector search

Embeddings are `halfvec(3072)` — half-precision, which halves index size and memory versus `vector` at negligible recall cost at this dimensionality.

Indexed with **HNSW** using `halfvec_cosine_ops`. HNSW over IVFFlat because it needs no training step and degrades gracefully as the corpus grows — IVFFlat's list count has to be tuned to a corpus size you don't know in advance.

Retrieval runs through `SECURITY INVOKER` SQL functions that filter by `user_id` **and** independently assert `auth.uid() = requesting_user_id`. The vector index cannot be queried across tenants even if the application layer passes a wrong id.

> The 3072 dimension is baked into the column type. Changing embedding model requires a migration *and* re-embedding every chunk — vectors from different models aren't comparable, and mixing them silently degrades retrieval.

## Storage

Supabase Storage, bucket `documents`, **private**, provisioned by migration rather than by a dashboard click — a bucket that exists only in someone's memory is a deployment that fails on first upload.

- Objects live under an owner-scoped prefix (`<user-id>/…`); storage policies key off that first path segment, so the path layout *is* the authorization boundary.
- Uploads are validated on content type **and** `%PDF-` magic bytes. Bucket-level MIME filtering trusts a client-supplied header, which is not a control.
- Downloads use short-lived signed URLs. The bucket is never made public.

## API architecture

Two complementary server surfaces:

**Server functions** (`createServerFn`) — typed RPC for the app's own UI, CSRF-protected, auth via middleware.

| Function | Purpose |
|---|---|
| `createDocumentUpload` | Issue a scoped upload target |
| `enqueueIngestion` / `runIngestionWorker` | Queue and drain ingestion |
| `getIngestionStatus` | Poll progress |
| `reindexDocument` / `deleteDocument` | Lifecycle |
| `getObservabilitySummary`, `listQueryTraces`, `getQueryTrace`, `listRecentEvents`, `getOperatorStatus` | Operator views |

**HTTP routes** — for streaming and for callers that aren't the app.

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/chat` | Bearer token | Streamed grounded answers |
| `POST /api/client-errors` | Bearer token | Browser error reports (always 202) |
| `GET /api/public/health` | none | Load-balancer probe |
| `GET /api/public/health?deep=1` | worker secret | Dependency probe incl. AI provider |
| `POST /api/public/worker-drain` | worker secret | External ingestion trigger |

All errors return a structured envelope — never a raw database message:

```json
{ "error": { "code": "DOCUMENT_NOT_FOUND", "message": "Document not found", "request_id": "qv_..." } }
```

Inputs are validated with Zod at the boundary. Rate limits are enforced per user in the database (so they hold across replicas) and **fail closed**.

## Security model

| Concern | Control |
|---|---|
| Tenant isolation | RLS on every table, plus independent `auth.uid()` assertions inside retrieval functions |
| Authorization ≠ authentication | Ownership is checked per resource; a valid session grants nothing by itself |
| Secret boundary | `VITE_*` is public; everything else is server-only. Enforced by an ESLint rule blocking client code from importing `*.server` modules, and verified by grepping the built bundle |
| Service role key | Server-side writers only. Never in a browser, never in a user-request path, never logged |
| Provider keys | Server-side only. The browser never contacts the AI provider |
| Prompt injection | Retrieved evidence is framed as untrusted reference data; instructions inside documents are data, not commands. Covered by an eval category |
| Citation forgery | Citations validated against the retrieved set server-side before persistence |
| Upload abuse | Content-type + magic-byte validation, size limits, per-user rate limits |
| CSRF | `createCsrfMiddleware` on all server functions |
| Error disclosure | Structured codes; raw PostgREST/Postgres text never reaches the UI |
| Logging | Redaction-aware — passwords, keys, tokens, and document contents are never logged |

Secrets are never committed; `.env` is git-ignored and `.env.example` contains only placeholders. A key that has ever been exposed should be **rotated**, not just removed.

## Local development

```bash
npm install
cp .env.example .env     # fill in real values
npm run dev              # http://localhost:3000
```

Quality gates:

```bash
npx tsc --noEmit    # types
npm run lint        # includes the secret-boundary rule
npm run test        # 197 unit + integration tests
npm run eval        # retrieval evaluation report
npm run eval:gate   # same, as a CI gate (exits 1 on regression)
npm run build       # production build
```

Tests and the eval harness run fully offline — no API key, no database, no network.

## Environment variables

Full reference with security notes: [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md#1-environment-variables). `.env.example` is authoritative.

**Public** (inlined into the browser bundle — never put a secret here):

| Variable | Required |
|---|---|
| `VITE_SUPABASE_URL` | yes |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | yes |
| `VITE_SUPABASE_PROJECT_ID` | yes |
| `VITE_ENABLE_GOOGLE_AUTH` | no (default `false`) |

**Server-only** (secrets marked 🔒):

| Variable | Required |
|---|---|
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_PROJECT_ID` | yes |
| 🔒 `SUPABASE_SERVICE_ROLE_KEY` | yes |
| 🔒 `OPENAI_API_KEY` (or `LOVABLE_API_KEY` / `AI_API_KEY`) | yes |
| 🔒 `INGESTION_WORKER_SECRET` | yes |
| `PORT`, `HOST`, `QV_RELEASE` | no |
| `QV_RATE_*`, `QV_MAX_CONCURRENT_INGESTIONS` | no |

## Database setup

Either apply migrations with the Supabase CLI:

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

…or, without CLI or database password, paste [`supabase/bootstrap.sql`](./supabase/bootstrap.sql) into the Supabase SQL Editor. It is every migration concatenated in order, regenerable with `bash scripts/generate-bootstrap.sh`.

Then verify — no table should report `rowsecurity = false`:

```sql
select relname, relrowsecurity from pg_class
where relnamespace = 'public'::regnamespace and relkind = 'r';
```

Details: [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md#3-database-migrations).

## Running the application

```bash
npm run build
npm run start        # HOST=0.0.0.0 PORT=3000 node .output/server/index.mjs
```

Production needs only Node and `.output/` — no Vite, no dev dependencies. Containerised setup: [`docs/DOCKER.md`](./docs/DOCKER.md).

## Production deployment

Full runbook: [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md) — environment variables, Supabase setup, migrations, storage, RLS, AI provider, build/start, production config, domains, monitoring, and rollback.

Short version: build a container, run it on a long-running host, point it at Supabase, terminate TLS at the proxy, health-check `/api/public/health`. Serverless is possible for the web surface but needs ingestion moved to an always-on worker — PDF parsing plus embedding routinely outlives a function timeout.

## Known limitations

- **PDF only.** No DOCX, HTML, Markdown, or plain text ingestion yet.
- **No OCR.** A scanned PDF with no text layer indexes as empty. It fails quietly from the user's point of view — the document appears indexed but never matches.
- **Small evaluation set.** 13 golden cases is a regression signal, not a benchmark.
- **Reranker cost.** The LLM reranker adds a call per query. The heuristic fallback keeps things working if it fails, but at lower quality.
- **In-process ingestion.** The worker shares the web process. A large backlog competes with request serving; `QV_MAX_CONCURRENT_INGESTIONS` bounds it but doesn't isolate it.
- **Fixed embedding dimension.** `halfvec(3072)` is schema-level. Changing models means a migration plus a full re-embed.
- **No per-document sharing.** Isolation is strictly per-user; there are no teams, orgs, or shared collections.
- **Build-time public config.** `VITE_*` values are baked into the bundle, so an artifact is environment-specific and can't be promoted staging→production unchanged.
- **Grounded, not hallucination-free.** The gate and citation validation substantially reduce unsupported answers. They do not eliminate them, and nothing does.

## Future improvements

- Additional formats (DOCX, HTML, Markdown) and OCR for scanned PDFs
- Extract the ingestion worker into its own process so it scales independently of web traffic
- Expand the golden set and add per-category thresholds
- Sharing model: teams, shared collections, per-document ACLs on top of the existing RLS
- Answer-level faithfulness scoring (claim-to-evidence entailment), beyond citation existence
- Cross-encoder reranking as a cheaper, more deterministic alternative to the LLM reranker
- Streaming ingestion progress to the UI instead of polling
- Runtime-injected public config, so one artifact can be promoted across environments

---

Design rationale: [`DESIGN.md`](./DESIGN.md) · Deployment: [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md) · Containers: [`docs/DOCKER.md`](./docs/DOCKER.md)
