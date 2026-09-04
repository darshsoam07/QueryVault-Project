# QueryVault

> Multi-tenant RAG platform with grounded citations and durable document ingestion.
> [Architecture](./ARCHITECTURE.md) · [Deployment](./docs/DEPLOYMENT.md) · [Security](./docs/SECURITY.md) · [Decisions](./docs/DECISIONS.md)

## What it is

QueryVault lets teams upload documents and ask natural-language questions against their own content, with answers **grounded in cited source chunks**. Every claim the system makes links back to a specific paragraph in an uploaded document; ungrounded responses are rejected before they reach the user.

Built as a multi-tenant SaaS: every row is protected by Postgres Row-Level Security, document ingestion runs as durable background work independent of any browser session, and the worker endpoint is authenticated with timing-safe Vault-backed secrets.

## Highlights

- **Grounded RAG** with mandatory citation gating; ungrounded answers rejected
- **Multi-tenant isolation** via Postgres RLS; 32 dedicated isolation tests
- **Durable ingestion** via `pg_cron` + `pg_net`; browser-independent, fail-closed
- **Hybrid retrieval**: pgvector HNSW + Postgres FTS, fused with reciprocal rank
- **254 tests passing**, 0 lint errors, 0 TypeScript errors, Windows + Linux builds

## Screenshots

_Screenshots will be added shortly._

## Architecture

```
User --> TanStack Start (Node 22) --> Supabase (Auth + Storage + pgvector)
                                              |
                                     ingestion_jobs (queue)
                                              |
                                     pg_cron every minute
                                              |
                                worker-drain (x-worker-secret)
                                              |
                                   chunk --> embed --> HNSW index
                                              |
                                   query --> hybrid retrieval
                                              |
                               evidence gate --> response with citations
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full breakdown.

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | React + TanStack Start + TypeScript |
| Backend | TanStack Start (Nitro, Node 22) |
| Database | Supabase Postgres + pgvector |
| Auth | Supabase Auth (Google OAuth + email) |
| Storage | Supabase Storage |
| Embeddings | OpenAI `text-embedding-3-small` |
| Retrieval | Hybrid: pgvector HNSW + Postgres FTS, RRF fusion |
| Background work | `pg_cron` + `pg_net` inside Supabase |
| Secrets | Supabase Vault, server-only env vars |
| Testing | Vitest |
| Build | Multi-stage Dockerfile, cross-platform npm scripts |

## Run locally

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
# Fill in Supabase URL, anon key, project ID, OpenAI key, INGESTION_WORKER_SECRET

# 3. Apply migrations
npx supabase db push

# 4. Store worker secret in Supabase Vault
# See docs/DEPLOYMENT.md for exact SQL

# 5. Run
npm run dev
```

## Project structure

```
src/
├── routes/
│   ├── api/public/worker-drain.ts   ← authenticated background worker
│   └── reference.tsx                ← UI for archived local-stack reference
├── lib/
│   ├── config/                      ← boot validation, env parsing
│   ├── retrieval/                   ← hybrid retrieval + evidence gating
│   ├── ingestion/                   ← chunk → embed → index pipeline
│   └── __tests__/                   ← scheduler, RAG, RLS tests
├── components/
└── ...
supabase/
└── migrations/
    └── 20260904000000_schedule_ingestion_worker.sql  ← pg_cron scheduler
docs/
├── DEPLOYMENT.md
├── DOCKER.md
├── SECURITY.md
├── TESTING.md
└── DECISIONS.md
```

## Testing

```bash
npm test          # 254 tests across 12 files
npm run typecheck # TypeScript, 0 errors
npm run lint      # 0 errors, 16 non-blocking Fast Refresh warnings
```

- 32 RLS isolation tests verifying cross-tenant access is blocked
- 13 RAG ground-truth cases covering citation validity and answer grounding
- 3 scheduler tests verifying migration structure and Vault-backed auth

See [docs/TESTING.md](./docs/TESTING.md)

## What this project demonstrates

- Production-grade RAG design, not a LangChain tutorial: hybrid retrieval, evidence gating, citation validation
- Multi-tenant data modeling with Postgres RLS as the source of truth
- Durable background work without an external worker host, with fail-closed security
- Secure-by-default architecture: service-role keys never reach the browser, worker auth is timing-safe and Vault-backed
- Honest test discipline: 254 tests, not claims of "fully tested"

## Honest limitations

- The scheduler migration has not been applied to a live Supabase project yet. Code is verified; remote state is not.
- The Docker image has not been built/pushed; Dockerfile is correct by inspection but the daemon was not running during validation.
- RAG evaluation baseline is 13/13 from a pre-Codex audit; a formal post-change re-run was blocked by network access to a real database.

These are documented, not hidden.

## License

MIT