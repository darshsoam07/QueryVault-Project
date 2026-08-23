# Deploying QueryVault

This document is the operational contract for running QueryVault outside a developer
laptop. It is written to be followed top to bottom on a fresh environment.

Two things are worth knowing before you start:

- **Supabase is a hard dependency.** Auth, Postgres (with pgvector), and Storage all
  live there. The Node server in this repo is stateless; every durable thing is in
  Supabase. There is no in-process cache to warm and no local disk to preserve.
- **The application server must be long-running.** Document ingestion is a durable
  queue drained by a worker inside the same process (`src/lib/ingestion/worker.server.ts`),
  and it holds job locks for up to 300 s. See
  [Platform choice](#platform-choice) — this rules some hosts in and others out.

---

## Contents

1. [Platform choice](#platform-choice)
2. [Environment variables](#1-environment-variables)
3. [Supabase setup](#2-supabase-setup)
4. [Database migrations](#3-database-migrations)
5. [Storage setup](#4-storage-setup)
6. [Row Level Security](#5-row-level-security)
7. [AI provider configuration](#6-ai-provider-configuration)
8. [Build command](#7-build-command)
9. [Start command](#8-start-command)
10. [Production configuration](#9-production-configuration)
11. [Domain configuration](#10-domain-configuration)
12. [Monitoring](#11-monitoring)
13. [Rollback strategy](#12-rollback-strategy)

---

## Platform choice

The build targets Nitro's `node-server` preset, so the artifact is an ordinary Node
process. That makes the following viable, in order of how well they fit:

| Target                                                                            | Verdict                     | Why                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Container on a long-running host** (ECS/Fargate, Fly.io, Render, Railway, a VM) | **Recommended**             | Matches the architecture exactly: one always-on process, horizontal scale by adding replicas, the ingestion worker drains continuously. See [`DOCKER.md`](./DOCKER.md).                                                                                                                                                                                                                                                                 |
| **Supabase**                                                                      | **Required, complementary** | Not an app host. It provides Auth, Postgres+pgvector, and Storage regardless of where the Node server runs.                                                                                                                                                                                                                                                                                                                             |
| **Vercel / serverless**                                                           | **Possible with a caveat**  | The web surface deploys fine (Nitro has a `vercel` preset). The problem is ingestion: PDF parsing plus embedding regularly exceeds serverless execution limits, and a function that is frozen mid-job leaves a row locked until the 300 s reclaim window expires. If you deploy serverless, move ingestion to a separate always-on worker and drive it through `POST /api/public/worker-drain`. Do not simply hope jobs finish in time. |
| **Static hosting** (S3/CloudFront alone, GitHub Pages)                            | **Not possible**            | There is server-side code: SSR, API routes, and every path that touches a secret. A static bundle cannot hold the service role key or the AI provider key, and by design must not.                                                                                                                                                                                                                                                      |

Scaling note: replicas are safe. Job claiming uses `SELECT … FOR UPDATE SKIP LOCKED`,
so two servers never process the same document, and chunk ids are deterministic, so a
retry upserts instead of duplicating.

---

## 1. Environment variables

The variable set is split by a **security boundary**, not by convenience.

- `VITE_*` is inlined into the browser bundle at build time. It is public. Assume
  anyone can read it in devtools.
- Everything else is server-only, read through `process.env` in `*.server.ts` modules
  and API routes.

**Never prefix a secret with `VITE_`.** Doing so publishes it. This is enforced by an
ESLint rule (`no-restricted-imports` in `eslint.config.js`) that stops
client-reachable code from importing any `*.server` module, and it is verified after
each build by grepping `.output/public` for secret material.

`.env.example` is the authoritative list. Copy it and fill in real values:

```bash
cp .env.example .env
```

### Public (browser-visible)

| Variable                        | Required             | Notes                                                                                                                        |
| ------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `VITE_SUPABASE_URL`             | Yes                  | `https://<project-ref>.supabase.co`                                                                                          |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Yes                  | New-format `sb_publishable_…` or a legacy anon JWT. Safe to ship **only because RLS is enabled on every table.**             |
| `VITE_SUPABASE_PROJECT_ID`      | Yes                  | Must be the same project as the URL and keys.                                                                                |
| `VITE_ENABLE_GOOGLE_AUTH`       | No (default `false`) | Set `true` only after Google is actually enabled in Supabase. While false the button is hidden rather than shown-and-broken. |

### Server-only

| Variable                                                  | Required                   | Notes                                                                                                                                                                                                                                        |
| --------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_URL`                                            | Yes                        | Same value as the `VITE_` one. Server code cannot read `import.meta.env`.                                                                                                                                                                    |
| `SUPABASE_PUBLISHABLE_KEY`                                | Yes                        | Same value. Used for user-scoped clients, so RLS still applies.                                                                                                                                                                              |
| `SUPABASE_PROJECT_ID`                                     | Yes                        | Same value.                                                                                                                                                                                                                                  |
| `SUPABASE_SERVICE_ROLE_KEY`                               | Yes                        | **SECRET. Bypasses RLS entirely — full read/write across every tenant.** Used only by server-authoritative writers (ingestion worker, admin functions). Never log it, never commit it, never send it to a browser.                           |
| `OPENAI_API_KEY` _or_ `LOVABLE_API_KEY` _or_ `AI_API_KEY` | Yes                        | **SECRET.** Provider credential; see [AI provider configuration](#6-ai-provider-configuration). Without one, ingestion fails at the embedding step and `/api/chat` returns `NOT_CONFIGURED` — it fails closed, it does not silently degrade. |
| `INGESTION_WORKER_SECRET`                                 | Yes                        | **SECRET.** Bearer token authorising `POST /api/public/worker-drain` and the deep health probe. Generate with `openssl rand -hex 32`.                                                                                                        |
| `PORT`                                                    | No (default `3000`)        |                                                                                                                                                                                                                                              |
| `HOST`                                                    | No (default `0.0.0.0`)     | Keep `0.0.0.0` in a container or the health check cannot reach it.                                                                                                                                                                           |
| `QV_RELEASE`                                              | Recommended                | Stamped onto telemetry so you can attribute a regression to a deploy. Set it to the image tag or git SHA.                                                                                                                                    |
| `NITRO_PRESET`                                            | No (default `node-server`) | Only change this to target a different host.                                                                                                                                                                                                 |

### Tuning knobs (all optional, sensible defaults)

| Variable                        | Default | Meaning                                                                                      |
| ------------------------------- | ------- | -------------------------------------------------------------------------------------------- |
| `QV_RATE_CHAT_PER_MIN`          | 30      | Chat requests per user per minute.                                                           |
| `QV_RATE_EMBED_PER_MIN`         | 120     | Embedding calls per user per minute.                                                         |
| `QV_RATE_UPLOAD_PER_5MIN`       | 12      | Uploads per user per 5 minutes.                                                              |
| `QV_RATE_CLIENT_ERROR_PER_5MIN` | 20      | Browser error reports per user per 5 minutes.                                                |
| `QV_MAX_CONCURRENT_INGESTIONS`  | 3       | Jobs drained at once **per replica**. Raise for throughput, lower to protect provider quota. |

Rate limiting is **fail-closed**: if the limiter cannot reach its table, the request is
rejected rather than allowed through unmetered.

### Secret handling in production

Do not ship a `.env` file. Use the platform's secret store and inject at runtime —
AWS Secrets Manager via an ECS task definition, Fly secrets, Render environment
groups. `.env` is git-ignored; keep it that way.

If a secret is ever exposed — committed, pasted into a ticket, logged — **rotate it**,
do not merely delete the exposure. Git history and log aggregators both persist.

### Configuration validation

Misconfiguration here does not produce a configuration error. It produces
`401 {"message":"Invalid API key"}` on every request, which reads as an
authentication bug and sends whoever is debugging it into the auth code. The
values are also inlined at build time, so the mistake is unfixable at deploy
time — a rebuild is the only remedy.

So the same validator (`src/lib/config/validate.ts`) runs at the three points
where it is still cheap to catch:

| Point                                                           | What happens                                                                                                                                                           |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Build** (`vite.config.ts`)                                    | Refuses to produce an artifact when a public value is missing or a placeholder. Always refuses when a `VITE_` variable holds a service-role key, whatever else is set. |
| **Server boot** (`server/plugins/config-guard.ts`)              | Refuses to start on a missing, placeholder, or cross-project server value, naming the variable. Logs `[config] ok — supabase project <ref>, release <tag>` when clean. |
| **Client construction** (`src/integrations/supabase/client.ts`) | Throws a named error rather than letting supabase-js issue requests with a placeholder key.                                                                            |

It detects missing values, placeholders, unparseable URLs, a project ref that
disagrees between the URL / `PROJECT_ID` / key claims, a key carrying the wrong
`role`, and `VITE_`/unprefixed pairs that have drifted apart.

Two things are **warnings**, not boot failures, because the server is still
useful without them: no AI provider key (`/api/chat` returns a structured
`NOT_CONFIGURED`) and no `INGESTION_WORKER_SECRET` (those endpoints fall back to
`worker_credentials` and stay fail-closed).

Findings name variables and report derived non-secret facts — a project ref, a
JWT `role`. **No configuration value is ever printed**, in a log line or in an
HTTP response.

The boot check is a Nitro startup plugin rather than a call in the server entry
because Nitro emits the SSR entry into a chunk it imports on the _first request_.
A check there is not a boot check: the container would come up, log `Listening`,
answer the liveness probe `200`, and only then fail every page. Plugins run
during app initialisation, before the listener serves. `src/server.ts` still
calls the same memoized check as a backstop for a host that skips Nitro plugins.

On a fatal finding the process **exits non-zero** in production rather than
throwing, so an orchestrator treats the task as failed and rolls back or restarts
instead of leaving a listening process that cannot serve. In development the error
is rethrown so the dev server shows it in place.

`QV_ALLOW_PLACEHOLDER_CONFIG=1` is a **build-time** opt-in used by CI to prove
the build compiles without holding real credentials. Never set it on a deployed
container, and never on a build whose artifact will be released: the artifact it
produces carries an unusable key.

---

## 2. Supabase setup

1. **Create the project.** Pick a region close to where the app server runs; every
   request crosses this hop.
2. **Collect credentials.** Dashboard → Settings → API. You need the project URL, the
   publishable/anon key, and the service role key. Put the service role key straight
   into the secret store — not into a file, not into chat.
3. **Enable email auth.** Dashboard → Authentication → Providers → Email.
   Decide about confirmation:
   - Confirmation **on** (recommended for production): sign-up returns no session and
     the UI tells the user to check their mail. Configure SMTP under Authentication →
     Emails, or confirmation mails will not arrive.
   - Confirmation **off**: sign-up signs the user straight in.

   The sign-up handler in `src/routes/auth.tsx` already distinguishes these cases, so
   either setting produces honest UI copy.

4. **Google sign-in (optional).** Authentication → Providers → Google; supply a
   Google OAuth client id and secret. Then add your redirect URL (see
   [Domain configuration](#10-domain-configuration)) and set
   `VITE_ENABLE_GOOGLE_AUTH=true`. Leave it disabled and the button stays hidden.
5. **Apply migrations** — next section.

---

## 3. Database migrations

Migrations live in [`supabase/migrations/`](../supabase/migrations) and are ordered by
filename. They create the tables, the pgvector index, the RLS policies, the retrieval
functions, and the storage bucket.

### Option A — Supabase CLI (preferred; keeps history)

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

`db push` records what it applied, so subsequent deploys apply only new files.

### Option B — SQL Editor, one shot (no CLI or DB password needed)

[`supabase/bootstrap.sql`](../supabase/bootstrap.sql) is every migration concatenated
in order, generated by [`scripts/generate-bootstrap.sh`](../scripts/generate-bootstrap.sh).
Paste it into Dashboard → SQL Editor → Run.

Use this for a first-time provision. It is idempotent enough to re-run, but it does
**not** record migration history, so afterwards either keep using the SQL Editor for
new migrations or run `supabase db push` once to reconcile.

### Verifying

```sql
-- Expect all 11: documents, document_chunks, threads, messages, profiles,
-- user_roles, worker_credentials, ingestion_jobs, telemetry_events,
-- query_traces, rate_limit_events
select table_name from information_schema.tables where table_schema = 'public';

-- Every one of them must report rowsecurity = true.
select relname, relrowsecurity from pg_class
where relnamespace = 'public'::regnamespace and relkind = 'r';

-- The vector index must exist, or retrieval falls back to a sequential scan.
select indexname from pg_indexes where tablename = 'document_chunks';
```

Regenerate the bootstrap file after adding a migration:

```bash
bash scripts/generate-bootstrap.sh
```

---

## 4. Storage setup

Migration `20260820000000_provision_documents_bucket.sql` creates a **private** bucket
named `documents` and its access policies, so there is normally nothing to do by hand.

Confirm in Dashboard → Storage:

- Bucket `documents` exists and is **not** public. A public bucket would make every
  uploaded PDF world-readable by URL and would defeat tenant isolation entirely,
  regardless of how correct the database policies are.
- Objects are stored under an owner-scoped prefix (`<user-id>/<document-id>…`). The
  storage policies key off that first path segment, so the path layout _is_ the
  authorization boundary — do not "tidy" it.

Downloads are served through short-lived signed URLs. Never switch the bucket to
public to work around a signing problem.

---

## 5. Row Level Security

RLS is the primary tenant boundary, and the deployment is not safe without it.

What the migrations set up:

1. **RLS enabled on every table**, with policies comparing `auth.uid()` to the row's
   `user_id`. A user with a valid session still cannot read another user's row.
2. **Retrieval functions re-assert ownership.** The hybrid-search functions are
   `SECURITY INVOKER` and additionally check `auth.uid() = requesting_user_id`. So even
   an application bug that passed the wrong user id would be rejected by the database.
   Authentication and authorization are separate here on purpose: being logged in is
   not access.
3. **Grants stripped.** A later migration revokes default grants so the publishable
   key cannot reach internals it has no business touching.

Verify after deploying — do not assume:

```sql
-- Must return no rows. Any row here is a table anyone with the public key can read.
select relname from pg_class
where relnamespace = 'public'::regnamespace
  and relkind = 'r' and relrowsecurity = false;
```

The service role key bypasses all of the above. That is exactly why it is confined to
server-side writers and must never be handed to a browser.

---

## 6. AI provider configuration

Chat and embeddings go through one abstraction, `src/lib/ai-gateway.server.ts`, which
selects a provider from the environment. Three are supported:

| Provider                       | Key variable      | Base URL                            |
| ------------------------------ | ----------------- | ----------------------------------- |
| OpenAI (default)               | `OPENAI_API_KEY`  | `https://api.openai.com/v1`         |
| Lovable AI Gateway             | `LOVABLE_API_KEY` | `https://ai.gateway.lovable.dev/v1` |
| Any OpenAI-compatible endpoint | `AI_API_KEY`      | `AI_BASE_URL` (required)            |

Selection is by which key is present, so an existing Lovable-only deployment keeps
working untouched. To be explicit, set `AI_PROVIDER` to `openai`, `lovable`, or
`openai-compatible`.

For `openai-compatible` you must also set `AI_CHAT_MODEL` and `AI_EMBEDDING_MODEL` —
there is no sensible default for an endpoint we know nothing about, so the gateway
refuses to start rather than guess. `AI_BASE_URL` (or `OPENAI_BASE_URL`) overrides the
base URL for any provider.

Rules that are not negotiable:

- **The key is server-only.** The browser never talks to the provider. All calls
  originate from the Node process. There is no `VITE_`-prefixed provider key, and
  adding one would publish your billing credential.
- **Missing key fails closed.** `/api/chat` returns a structured `NOT_CONFIGURED`
  error and ingestion fails at the embedding step. It does not fall back to an
  ungrounded answer.
- **Embedding dimensions are baked into the schema.** The column is
  `halfvec(3072)`. Switching to a model with a different output size requires a
  migration _and_ re-embedding every existing chunk. Changing the model without
  reindexing yields silently poor retrieval — vectors from two models are not
  comparable.

Check reachability without deploying a chat request:

```bash
curl -H "Authorization: Bearer $INGESTION_WORKER_SECRET" \
  "https://your-domain.example/api/public/health?deep=1"
```

---

## 7. Build command

```bash
npm ci        # or: bun install --frozen-lockfile
npm run build
```

This emits `.output/`:

- `.output/public/` — browser assets. **Contains only public config.**
- `.output/server/` — the Node server, entry `index.mjs`.

`NITRO_PRESET` defaults to `node-server`; `npm run build:node` sets it explicitly.

Gate a release on the full check set, not just the build:

```bash
npx tsc --noEmit          # types
npm run lint              # includes the secret-boundary import rule
npm run test              # unit + integration
npm run eval:gate         # retrieval quality gate; exits 1 on regression
npm run build
```

Do not ship past a failing step. The eval gate exists specifically so a silent
retrieval regression fails the build instead of reaching users.

**Post-build secret check.** Cheap, and it catches the mistake that matters most:

```bash
grep -rEo "sb_secret_[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}|SUPABASE_SERVICE_ROLE_KEY|INGESTION_WORKER_SECRET" .output/public && echo "LEAK" || echo "clean"
```

Match the secret _value_, not a name or a prefix. `sb_secret_` on its own appears
legitimately in the browser bundle — the shared key-format helper does
`key.startsWith("sb_secret_")` to reject a service-role key handed to the client, so
the bare 10-character literal is present by design. What must never appear is that
prefix followed by real key characters (`sb_secret_` + a random tail), a JWT-shaped
token (`eyJ…`), or an `sk-…` provider key. The pattern above requires the trailing
value, so it flags an actual leak without tripping on the guard that prevents one.

Build-time note: `VITE_*` values are inlined **at build time**, so the browser bundle
is environment-specific. A build made against staging keys is a staging artifact —
promoting that exact artifact to production would point users' browsers at staging
Supabase. Either build per environment, or serve those three values at runtime.

Because that mistake cannot be corrected after the fact, the build refuses to run
without real public config — see
[Configuration validation](#configuration-validation). If you only want to prove
the build compiles, declare it:

```bash
QV_ALLOW_PLACEHOLDER_CONFIG=1 npm run build
```

The resulting artifact is a verification artifact and must not be deployed.

---

## 8. Start command

```bash
npm run start
```

which is:

```bash
HOST=${HOST:-0.0.0.0} PORT=${PORT:-3000} node .output/server/index.mjs
```

Production needs only `node` and the `.output/` directory — no Vite, no dev
dependencies, no build toolchain. In a container, install with `--production` (or use
a multi-stage build) so dev tooling never ships. See [`DOCKER.md`](./DOCKER.md).

The process is stateless; kill and restart it freely. In-flight ingestion jobs are
reclaimed automatically after their lock expires (300 s), so an abrupt shutdown loses
no work — it only delays it.

---

## 9. Production configuration

**Health check.** Point the load balancer at `GET /api/public/health`. It returns 200
when healthy, 503 when a third-party dependency is down, and 500 when the fault is
ours — a missing schema, a missing SQL function, absent configuration. Use the shallow
form for the balancer; the `?deep=1` variant calls the AI provider and costs money on
every poll.

The probes assert a positive result rather than the absence of an error, which is not
the same thing at this boundary. Two examples, both of which produced a false green
before they were fixed: a HEAD request against a table that does not exist is answered
`204` with no body, so `error` is null and the database looks fine; and
`storage.from(bucket).list()` returns `{ data: [], error: null }` for a bucket that does
not exist. So `database` runs a real GET and requires a row set back, and `storage` calls
`getBucket` — which also lets readiness fail if the bucket has been flipped **public**,
reported as `config` since every object in it is private user data.

The practical consequence: an instance pointed at a project whose migrations were never
applied reports `database: down` and fails readiness, instead of passing the probe and
taking traffic.

**Ingestion worker.** Each replica drains its own queue in-process, up to
`QV_MAX_CONCURRENT_INGESTIONS` at a time. To drive draining externally (required on
serverless), call:

```bash
curl -X POST -H "Authorization: Bearer $INGESTION_WORKER_SECRET" \
  https://your-domain.example/api/public/worker-drain
```

**Rate limits.** Defaults are per-user and reasonably tight. They are enforced in the
database, so they hold across replicas rather than per-process. Fail-closed by design.

**CSRF.** Server functions are protected by `createCsrfMiddleware` in `src/start.ts`,
which compares request origin against host. Behind a proxy, forward `Host` and
`X-Forwarded-Proto` correctly or legitimate requests will be rejected as cross-site.

**TLS.** Terminate at the load balancer or proxy; the Node process speaks plain HTTP.
Never expose it directly to the internet — Supabase access tokens ride in
`Authorization` headers.

**Logging.** `logEvent` is redaction-aware: passwords, keys, tokens, and document
contents are never written. Keep it that way — if you add a log line, log the request
id (`qv_<24>`), not the payload.

**Release stamping.** Set `QV_RELEASE` to the git SHA or image tag so telemetry can
attribute a regression to a specific deploy.

---

## 10. Domain configuration

1. **DNS** → your load balancer or platform hostname.
2. **TLS certificate** for the domain (ACM, Let's Encrypt, or platform-managed).
3. **Supabase redirect allow-list** — Dashboard → Authentication → URL Configuration:
   - _Site URL_: `https://your-domain.example`
   - _Redirect URLs_: `https://your-domain.example/chat`, plus
     `http://localhost:3000/chat` for local development.

   OAuth and email-confirmation links land on an error page if the exact URL is not
   listed. This is the most common cause of "sign-in worked locally but not in
   production".

4. **Google OAuth (if enabled)** — add the Supabase callback
   (`https://<project-ref>.supabase.co/auth/v1/callback`) to the authorised redirect
   URIs of your Google OAuth client, then set `VITE_ENABLE_GOOGLE_AUTH=true` and
   rebuild (it is a `VITE_` value, so it is baked in at build time).
5. **Proxy headers** — forward `Host` and `X-Forwarded-Proto`, per the CSRF note above.

---

## 11. Monitoring

The application ships its own observability; there is no external APM dependency.

**Health endpoints**

| Endpoint                        | Auth                      | Use                                                                                    |
| ------------------------------- | ------------------------- | -------------------------------------------------------------------------------------- |
| `GET /api/public/health`        | none                      | Load balancer probe. 200 healthy / 503 unhealthy.                                      |
| `GET /api/public/health?deep=1` | `INGESTION_WORKER_SECRET` | Post-deploy verification. Also pings the AI provider — costs money, so do not poll it. |

**Telemetry tables**

- `telemetry_events` — structured application events (ingestion lifecycle, chat
  outcomes, auth failures, rate-limit hits, browser exceptions). Redaction-safe.
- `query_traces` — per-query retrieval detail: candidate counts, fusion and rerank
  scores, evidence-gate outcome, latency. This is what tells you _why_ an answer was
  refused.
- `rate_limit_events` — the limiter's own ledger.

**Summary RPC**

```sql
select * from observability_summary();
```

**Request correlation.** Every request carries a `qv_<24-char>` id, returned in error
envelopes as `request_id`. A user reporting a failure can give you that id and it will
match a telemetry row — without any of them having to paste sensitive content.

**What to alert on**

| Signal                                   | Why it matters                                                                                                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/public/health` 503                 | A third-party dependency is down — wait or fail over.                                                                                                                        |
| `/api/public/health` 500                 | Our fault, and retrying will not fix it: unapplied migrations, a missing SQL function, missing configuration, or a bucket that has been made public. Read `checks[].detail`. |
| Rising `ingestion_jobs` rows in `failed` | Provider quota, malformed PDFs, or a bad deploy.                                                                                                                             |
| Rising evidence-gate refusals            | Retrieval quality regression, or a corpus that genuinely lacks answers.                                                                                                      |
| `client.unhandled_error` volume          | A browser-side regression the server sees as success.                                                                                                                        |
| Rate-limit hits climbing                 | Either abuse, or limits set too tight for real usage.                                                                                                                        |

---

## 12. Rollback strategy

Application code and database schema roll back differently. Treat them separately.

### Application

The build artifact is immutable, so rollback is redeploying the previous image or
release:

```bash
# container platforms
docker run <registry>/queryvault:<previous-tag>
# ECS: update the service to the previous task definition revision
```

Keep the last few tags. Because the process is stateless, rollback is safe at any
time — no local state to migrate, no cache to invalidate. In-flight ingestion jobs are
reclaimed after the lock window and processed by whichever version is running.

Remember that `VITE_*` values are baked into each artifact, so rolling back code also
rolls back the public config it was built with.

### Database

**Migrations are forward-only.** There are no down-migrations here, deliberately: an
automated down-migration on a table holding user documents is a data-loss weapon.

Before applying migrations to production:

1. Take a snapshot — Dashboard → Database → Backups, or `pg_dump`. For anything that
   drops or rewrites a column, do this without exception.
2. Read the migration and classify it:
   - **Additive** (new table, new column, new index) — safe. Roll back the application
     alone; the extra object sits unused.
   - **Destructive** (drop, type change, backfill) — the application cannot be rolled
     back independently. Write and rehearse a forward-fix migration _before_
     deploying, or restore from the snapshot.
3. Prefer expand/contract for anything risky: deploy the additive migration, deploy
   code that works with both shapes, then remove the old shape in a later release.
   This keeps every intermediate state rollback-safe.

### Rotating a leaked secret

Not strictly rollback, but the same urgency:

1. Supabase Dashboard → Settings → API → rotate the service role key. Or revoke the
   AI provider key at the provider.
2. Update the secret store.
3. Redeploy so every replica picks up the new value.
4. Check `telemetry_events` for use of the old credential in the exposure window.

Rotate rather than hope. A key that appeared in a public commit is compromised even
after the commit is deleted.

---

## Post-deploy checklist

```
[ ] /api/public/health returns 200
[ ] /api/public/health?deep=1 reports the AI provider reachable
[ ] Sign-up, then sign-in, then sign-out all work
[ ] No table reports rowsecurity = false
[ ] Two accounts cannot see each other's documents (test it, don't assume it)
[ ] Upload a PDF; it reaches `indexed`, not stuck in `queued`
[ ] Ask a question answerable from that PDF — answer arrives with citations
[ ] Ask something the PDF does not cover — the system refuses instead of inventing
[ ] grep .output/public for secret material: clean
[ ] QV_RELEASE is set to this deploy's SHA or tag
```
