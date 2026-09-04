# Security

This document covers the security model of QueryVault. For secret configuration steps, see [docs/DEPLOYMENT.md](./DEPLOYMENT.md). For the reasoning behind key decisions, see [docs/DECISIONS.md](./DECISIONS.md).

---

## Service-role key isolation

`SUPABASE_SERVICE_ROLE_KEY` bypasses all Row-Level Security. It is treated accordingly:

- Read only in `.server.ts` files via `process.env` -- never imported into any client-side or shared module.
- Never assigned to a `VITE_` prefixed variable (which would inline it into the browser bundle).
- `validateSupabaseConfig` at boot rejects any configuration where the key carries a publishable-key prefix or appears in a `VITE_` slot.
- `collectBootFindings` redacts the value in all diagnostic output -- only the derived project ref and role are logged.
- Dedicated tests verify both the boot-level rejection and the redaction behaviour.

**Threat:** A misconfigured developer accidentally sets `VITE_SUPABASE_SERVICE_ROLE_KEY`.
**Mitigation:** Boot validation fails loudly before the server serves traffic.

---

## VITE_ variables

`VITE_*` variables are inlined into the browser bundle at build time and are therefore public. Only publishable values belong there:

| Variable | Safe because |
|---|---|
| `VITE_SUPABASE_URL` | Supabase project URL -- visible in browser network tab anyway |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Anon key -- RLS enforces access regardless |
| `VITE_SUPABASE_PROJECT_ID` | Project reference -- not a credential |
| `VITE_ENABLE_GOOGLE_AUTH` | Feature flag -- no secret value |

No `VITE_*` variable holds any secret. This is enforced at boot, not by convention.

---

## Worker endpoint authentication

`POST /api/public/worker-drain` is the only public write endpoint that bypasses the normal Supabase Auth session flow. It is protected by:

1. **Shared secret** -- `INGESTION_WORKER_SECRET` injected via server environment variable.
2. **Timing-safe comparison** -- constant-time equality check prevents timing oracle attacks.
3. **Single auth path** -- only `x-worker-secret` header is accepted; no fallback, no override, no `Authorization: Bearer` variant.
4. **Fail-closed** -- if `INGESTION_WORKER_SECRET` is not set, the endpoint returns 401 immediately.

The scheduler reads the same secret from Supabase Vault at call time. If the Vault secret is absent, no HTTP request is sent.

---

## Row-Level Security

Every table that holds tenant data has RLS enabled. Policies use `auth.uid()` to scope rows.

The service-role key bypasses RLS only in server-side ingestion code -- and only for the specific operations (inserting chunks, updating job state) that require it. User-facing queries use the anon/user key scoped to the authenticated session.

**32 dedicated RLS tests** attempt cross-tenant reads and writes and assert they are blocked.

---

## Tenant isolation

Multi-tenant isolation relies on RLS as the source of truth, not application-layer `WHERE` clauses. Application code adds tenant scoping as defense-in-depth, but is allowed to trust the database -- a bug in application code cannot leak cross-tenant data if RLS rejects the query.

---

## Secret scanning

The following checks are applied:

- `grep` for `console.log.*SECRET|SERVICE_ROLE|PASSWORD` -- no matches in source.
- `grep` for `Authorization: Bearer` across all `.ts`, `.tsx`, `.md` -- zero occurrences.
- Production build output (`.output/server/index.mjs`) scanned for `SUPABASE_SERVICE_ROLE_KEY`, `INGESTION_WORKER_SECRET`, `worker_credentials` -- none found.
- `.env` and `.env.*` are gitignored.

---

## .env handling

`.gitignore` excludes `.env` and `.env.*`. The repository contains only `.env.example` (no values) and `.env.docker.example` (no values). No secret has ever been committed.

---

## Reporting a vulnerability

Please open a private GitHub Security Advisory rather than a public issue.