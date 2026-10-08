# QueryVault -- Resume Bullets

For applications and interviews. Pick 2-3 per role.

## Core description

QueryVault -- Multi-tenant RAG platform with grounded citations and durable ingestion.

## Bullet 1 -- Full-stack scope

Designed and shipped a full-stack TypeScript RAG system (React + TanStack Start + Supabase + pgvector)
with hybrid retrieval and mandatory citation validation. 254 tests across 12 files; 0 lint errors; 0
TypeScript errors; production build verified cross-platform.

## Bullet 2 -- Background work + security

Implemented durable document ingestion using pg_cron + pg_net inside Postgres, with Supabase
Vault-backed timing-safe worker authentication and fail-closed defaults. Browser-independent queue
draining; no external scheduler required.

## Bullet 3 -- Multi-tenant data modeling

Built multi-tenant isolation via Postgres Row-Level Security as the source of truth; 32 dedicated
isolation tests verify cross-tenant access is blocked. Service-role key kept out of browser bundles
via boot-time validation.

## Bullet 4 -- Production hygiene

Multi-stage non-root Dockerfile with healthcheck; cross-platform npm scripts via cross-env;
documented deployment, security, testing, and architecture decisions in dedicated docs/. Honest
limitations documented in README.

## Bullet 5 -- RAG design

Hybrid retrieval fusing pgvector HNSW cosine search with Postgres full-text search via reciprocal
rank fusion; evidence-gated responses reject ungrounded claims before they reach the user.

## Interview prompts for me to be ready for

- "Why pg_cron + pg_net instead of a worker host?" --> ADR-001
- "Why hybrid retrieval?" --> ADR-002
- "Why RLS over app-layer checks?" --> ADR-003
- "What would you do differently with more time?" --> switch to OpenAI native file IDs, add
  observability, implement a self-hosted embedding alternative.