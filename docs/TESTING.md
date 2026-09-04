# Testing

This document describes the test suite, what each group of tests covers, and how to run them.

---

## Running tests

```bash
npm test          # full suite — 254 tests across 12 files
npm run typecheck # TypeScript type check — 0 errors
npm run lint      # ESLint + Prettier — 0 errors
```

All three commands run in CI on every push.

---

## Test file inventory

| File | Tests | What it covers |
|---|---|---|
| `src/lib/__tests__/rls.test.ts` | 32 | Cross-tenant isolation; RLS blocks reads and writes |
| `src/lib/__tests__/auth.test.ts` | 26 | Bearer token verification; fail-closed on missing config |
| `src/lib/__tests__/config.test.ts` | 50 | Boot validation; service-role key detection in VITE_ vars; redaction |
| `src/lib/__tests__/health.test.ts` | 17 | Liveness and readiness probe logic; deep probe auth |
| `src/lib/__tests__/security.test.ts` | 22 | Secret exposure checks; header validation; timing-safe auth |
| `src/lib/__tests__/ingestion.test.ts` | 16 | Ingestion pipeline stages; idempotency; retry logic |
| `src/lib/__tests__/scheduler.test.ts` | 3 | Migration structure; Vault-backed credentials; canonical auth header |
| `src/lib/__tests__/retrieval.eval.test.ts` | 20 | Hybrid retrieval; RRF fusion; chunk ranking |
| `src/lib/__tests__/evaluation.test.ts` | 16 | RAG evaluation harness; evidence gate; citation validation |
| `src/lib/__tests__/documents.test.ts` | 22 | Document CRUD; upload validation; tenant scoping |
| `src/lib/__tests__/client-errors.test.ts` | 12 | Error sanitization; no internal details leaked to client |
| `src/components/queryvault/__tests__/KnowledgePanel.test.tsx` | 18 | UI deletion flow; RLS error redaction in the component layer |

**Total: 254 tests across 12 files.**

---

## Test groups

### RLS isolation (32 tests)

These tests directly verify that cross-tenant access is blocked at the database layer. Each test sets up data as tenant A, then attempts to read or write it as tenant B and asserts a rejection.

These tests do not mock RLS — they use the actual Supabase Postgres client with real policy enforcement.

### Config and boot validation (50 tests)

Covers `validateSupabaseConfig` and `collectBootFindings`. Key cases:

- Service-role key placed in a `VITE_` variable ? rejected
- Missing required env vars ? correct warning codes
- Redacted output — secret values must not appear in diagnostic strings
- Project ref cross-check between `VITE_` and server-side keys

### Scheduler tests (3 tests)

Reads the migration file and worker route source and asserts:

1. Migration uses an idempotent `IF NOT EXISTS` guard and a `* * * * *` schedule named `queryvault-ingestion-worker`
2. Credentials are loaded from `vault.decrypted_secrets` — no literal URL or secret baked in
3. The scheduler sends `x-worker-secret`; the worker route accepts only `x-worker-secret`; no `x-worker-token` or `worker_credentials` references exist

### RAG evaluation (13 ground-truth cases)

The offline evaluation runner (`evaluation/runner.ts`) tests the full RAG pipeline against known document/question/answer triples. Each case asserts:

- The answer is grounded (at least one citation)
- The cited chunk IDs appear in the retrieved set
- The answer is not hallucinated (checked against ground-truth expected content)

**Baseline: 13/13 PASS** from the pre-remediation audit. No RAG logic was changed during remediation; the baseline is expected to hold. A formal re-run requires a live Supabase connection and an AI provider key.

```bash
npm run eval        # run and report
npm run eval:gate   # run and fail CI if any case fails
```

---

## Lint

```bash
npm run lint
```

**0 errors. 16 warnings.**

All 16 warnings are `react-refresh/only-export-components` in Radix UI primitives and Lovable-generated UI kit files. They affect only hot-reload granularity in development; production builds are unaffected. Refactoring to eliminate them would require splitting ~10 files with meaningful behavioral risk for zero runtime gain.

---

## TypeScript

```bash
npm run typecheck
```

**0 errors.** Runs `tsc --noEmit` against the full source tree.

---

## What is not tested

- **Docker image:** Dockerfile is correct by inspection; the daemon was unavailable during the last validation run.
- **Remote Supabase migrations:** migration SQL is verified at code level; remote application requires manual `supabase db push`.
- **RAG evaluation re-run post-remediation:** blocked by external connectivity; expected to hold at 13/13.
