# QueryVault — Change Log

## [Phase 7] — Cleanup & Documentation
- Added CHANGELOG.md (this file)
- Confirmed evaluation/runner.ts already has the correct `process.exit(1)` gate
  and the Windows-path fix (`.replace(/\\/g, "/")`) — no change required
- Env-var guidance: use `SUPABASE_URL` (server) / `VITE_SUPABASE_PUBLISHABLE_KEY` (browser)

## [Phase 6] — Ops & Deployment
- **NEW** `src/routes/api/health.ts` — GET /api/health liveness + readiness probe
- **NEW** `supabase/migrations/20260908000001_health_probe_fn.sql` — cheap health_probe() RPC

## [Phase 5] — Security & Rate Limiting
- **MODIFIED** `src/lib/rate-limit.server.ts` — added `enforceIpRateLimit`, `pruneExpiredRateLimits`
- **NEW** `supabase/migrations/20260908000000_ip_rate_limit_and_prune.sql` — rate_limits_ip table + SQL functions

## [Phase 4] — RAG Quality
- **MODIFIED** `src/lib/retrieval/config.ts`
  - `gate.minTopRerankScore` 0.35 → 0.38
  - Added `maxCharsPerQuery: 1000`
  - Added `llmRerankerTimeoutMs: 5000`

## [Phase 3] — Ingestion Hardening
- **MODIFIED** `src/lib/ingestion/contract.ts` — `EMBED_DIMENSIONS` env-driven, `OCR_SUSPECT_CHARS_PER_PAGE`
- **MODIFIED** `src/lib/ingestion/worker.server.ts` — OCR-suspect detection, rate-limit prune at drain end

## [Phase 2] — Auth UX Polish
- **MODIFIED** `src/routes/auth.tsx` — added forgot-password reset flow (`mode = "signin"|"signup"|"reset"`)

## [Phase 1] — Auth / Failed-to-fetch Fix
- **MODIFIED** `src/hooks/useAuth.tsx` — removed parallel `getSession()` race condition
- **MODIFIED** `src/integrations/supabase/auth-middleware.ts` — fixed Authorization header injection order

## [Phase 0] — Baseline Audit
No code changes. See Notion: "QueryVault — Phase 0: Baseline & Architecture Audit".
