# Phase 6 local readiness

Reviewed 16 October 2026 (Asia/Calcutta). **Local mocked-browser acceptance passes. Overall live/full-stack acceptance remains BLOCKED.** No software/model/container-image downloads or installations, paid requests, hosted writes, model changes, push or deployment occurred.

## 1. Root cause of the saved-history failure

Instrumented the unchanged saved-history test with sanitized console errors, failed request paths, HTTP status, hydration timing and pending-module diagnostics. The first instrumented run passed: hydration 9467 ms, mocked history requests HTTP 200, no browser errors.

A forced cold-start reproduction then captured **`net::ERR_NETWORK_IO_SUSPENDED`** loading React/TanStack JavaScript, followed by `TypeError: Failed to fetch dynamically imported module`. Those requests failed before React hydration could mount authentication/history effects. The elapsed run also spanned a prolonged interruption. This reproduced failure is a browser transport/environment suspension, not evidence of an Auth callback deadlock, failed history query, or zero-cost fetch rejection. The underlying OS/browser suspension trigger was not established. Historical Phase 5 failures lacked these diagnostics, so their precise cause cannot be retroactively proved.

No application hydration/auth retry was added to hide failed script loading, and no timeout, existing assertion, two-pixel scroll tolerance or validation threshold was increased/removed. A suspended host can still invalidate a browser run; keep the test host awake and review diagnostics rather than treating a failed run as passed.

During hardening of test isolation, a separate **real application configuration defect** was found: boot/build validation allowed only HTTPS-style hosted URLs, so explicit local-only Supabase HTTP endpoints were rejected. This would prevent the prepared `dev:zero-cost` workflow from starting even with valid local credentials. This defect was fixed without allowing HTTP hosted endpoints in normal mode.

## 2. Fixes implemented

- `src/lib/config/validate.ts`: explicit `QV_LOCAL_ONLY=1` or `VITE_QV_LOCAL_ONLY=1` accepts only credential-free HTTP loopback endpoints. Normal hosted validation remains unchanged. Local JWT installation refs are not confused with hosted URL refs; required credentials, key roles, public-secret rejection and server/browser mirror checks still apply.
- `src/lib/config/boot.server.ts`, `vite.config.ts`: pass local-only flags into the existing validation path. Nine local-configuration regressions cover valid boot and invalid/missing/mismatched/secret cases; prior configuration and cost-policy assertions remain intact.
- `playwright.config.ts`: removes automatic loading of hosted `.env`; checks loopback app/Supabase URLs before creating clients; sets explicit local project mirrors, fake fixture credentials for mocked mode, zero-cost flags and disabled AI tests/keys. It starts its own server instead of reusing an unrelated server. `QV_E2E_COLD_START=1` is a diagnostic option for forced dependency preparation, not a relaxed timeout.
- `e2e/chat-scroll-pagination.spec.ts`: the database-writing test now rejects a non-loopback target even if `QV_E2E_ISOLATED=1` is accidentally set. A flag alone cannot authorize hosted writes.
- `e2e/mocked-scroll.spec.ts`: adds safe diagnostics, avoids replacing an already-persisted synthetic session on reload, and explicitly refreshes saved history and rechecks its citation text/page mapping. Existing initial 50 rows, older 60 rows and two-pixel anchor assertions remain.

The final successful complete browser run used `QV_LOCAL_ONLY=1` in both the server and browser. Initial hydration was 9607 ms and reload hydration 1308 ms. Documents, threads and message requests were mocked HTTP 200; final pending-request list was empty. Saved citation/scroll test passed in 15.4 seconds and the 20-document test in 3.8 seconds. These are synthetic browser-run timings, not real ingestion/AI/database throughput measurements.

## 3. Actual test results

| Command | Actual result / boundary |
| --- | --- |
| `npm test -- --configLoader native --maxWorkers 1` | 559 passed, 2 opt-in live tests skipped; 34 files passed, 1 skipped; local/mocked |
| `node node_modules/typescript/bin/tsc --noEmit` | Passed |
| `npm run lint` | Zero errors, 14 existing warnings |
| `npm run build` | Passed |
| `npm run eval:gate` | Existing retrieval thresholds and 12 deterministic safety checks passed |
| `npm run security:client` | No configured private key values found in public output |
| `npm run test:e2e` | 2 passed, 1 local-database-writing test explicitly skipped |
| Live AI, full real local Supabase HTTP/worker acceptance | Not run; blocked, not passed |

The two unit-test skips are the real Gemini embedding and support-verifier opt-ins, disabled because account-specific ₹0 eligibility remains unverified. The browser skip is the database-writing pagination test: no running dedicated local stack/service-role credentials were supplied. The final complete browser run took 27.8 seconds; the preceding complete run also passed (38.5 seconds). Supabase HTTP boundaries in the two passing tests were mocked; no live model accuracy or real Auth/Storage claim is made. See [sanitized evidence](phase6/results.json) and [browser diagnostics](phase6/browser-diagnostics.json).

The forced-cold diagnostic run failed with network suspension. An intermediate isolated-server startup failed the old boot guard, which led to the loopback fix. A new unit fixture initially triggered the existing placeholder check before its intended URL assertion; it was corrected to a non-placeholder hosted URL, preserving that assertion. These failed investigations are not counted as passing acceptance checks.

`node scripts/dev-zero-cost.mjs` without `.env.zero-cost.local` exited 1 before starting a server, as intended. The launcher requires separate local credentials and does not silently use the hosted environment. Valid local boot is verified by unit checks and the local-only mocked browser server; a full real local Supabase launch remains unrun.

## 4. Local Supabase prerequisites

Installed and observed: Node.js 24.18.0, Bun, Docker Desktop/Docker-compatible CLI; cached `pgvector/pgvector:pg17` used in earlier disposable SQL checks. Supabase CLI and Ollama are not on PATH. No installation was performed. Phase 5 SQL evidence remains historical; SQL migrations were not modified or rerun in Phase 6.

Missing for full stack: official Supabase CLI and its local PostgreSQL/pgvector, Auth (GoTrue), Storage, REST (PostgREST), API gateway and supporting Studio/email/runtime container images. CLI start resolves the compatible image versions; do not assemble unrelated latest images manually. Docker/WSL2 Linux-container support, loopback port availability (54321–54324 plus required ancillary ports), sufficient disk/RAM and download bandwidth are required. Existing preparation has a distinct `queryvault-zero-cost` ID, 21 copied migrations, templates, loopback redirects and analytics disabled at `.verification/supabase-zero-cost`; repository `supabase/config.toml` was preserved.

The owner selected setup only/no downloads. The following commands are **prepared instructions requiring separate approval**, not executed work. [Official Windows/CLI guidance](https://supabase.com/docs/guides/local-development/cli/getting-started) supports a project-local npm CLI and Docker-compatible runtime. Pin proposed CLI [2.121.0](https://github.com/supabase/cli/releases/tag/v2.121.0); review the release and image requirements before approving installation. No hosted account, payment method or CLI login is needed for the local stack.

## 5. Exact Windows setup commands (do not run before approval)

Use PowerShell from this repository. Install only in the ignored tooling directory so the application dependency locks remain unchanged:

```powershell
Set-Location -LiteralPath 'C:\Users\daksh\Downloads\QueryVault Project'
$cliHome = Join-Path (Get-Location) '.verification\supabase-cli'
$stackRoot = Join-Path (Get-Location) '.verification\supabase-zero-cost'
$env:SUPABASE_TELEMETRY_DISABLED = '1'
$env:DO_NOT_TRACK = '1'
Remove-Item Env:SUPABASE_ACCESS_TOKEN -ErrorAction SilentlyContinue

# Approval required: package/binary download. This does not upgrade app dependencies.
New-Item -ItemType Directory -Path $cliHome -Force | Out-Null
npm install --prefix "$cliHome" --save-exact supabase@2.121.0
if ($LASTEXITCODE -ne 0) { throw 'CLI installation failed' }
$cli = Join-Path $cliHome 'node_modules\.bin\supabase.cmd'
& $cli --version
docker version

# Prepare only if absent; do not overwrite existing repository/local configuration.
if (-not (Test-Path -LiteralPath $stackRoot)) {
  node scripts/prepare-local-supabase.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Local preparation failed' }
}
if (Test-Path -LiteralPath (Join-Path $stackRoot 'supabase\.temp\project-ref')) {
  throw 'Refuse a workspace linked to a hosted project'
}

# Approval required: first start downloads multiple container images.
& $cli start --workdir "$stackRoot"
if ($LASTEXITCODE -ne 0) { throw 'Local stack did not start' }
& $cli status --workdir "$stackRoot"
# Keep credential output local. Do not paste it into chat or commit it.
```

Check the resulting service bindings and local migration state; abort if URLs are remote. Do not disable health checks to force a successful start. Do not run `login`, `link`, hosted `db push`, or use `--linked`/remote DB URLs. Leave Vault worker URL/secret unset until a separately validated local-only scheduler setup is needed.

Create the isolated app file only if absent, then enter **local** keys shown by the local CLI and a fresh local worker secret:

```powershell
if (Test-Path -LiteralPath '.env.zero-cost.local') {
  throw 'Local app configuration exists; inspect it instead of overwriting'
}
Copy-Item -LiteralPath 'config\zero-cost.env.example' -Destination '.env.zero-cost.local'
notepad .env.zero-cost.local
# Keep both Supabase URLs http://127.0.0.1:54321 and both project IDs equal.
# Use local anon/publishable and local service-role/secret credentials only.
npm run dev:zero-cost
```

The real local database test can run only after the stack is verified. In a separate PowerShell terminal, export its **local-only** URLs/keys into the process without logging them, then:

```powershell
Set-Location -LiteralPath 'C:\Users\daksh\Downloads\QueryVault Project'
$cliHome = Join-Path (Get-Location) '.verification\supabase-cli'
$stackRoot = Join-Path (Get-Location) '.verification\supabase-zero-cost'
$cli = Join-Path $cliHome 'node_modules\.bin\supabase.cmd'
# URL/key variables must come from the local stack, never the hosted .env.
$env:VITE_SUPABASE_URL = 'http://127.0.0.1:54321'
$env:SUPABASE_URL = 'http://127.0.0.1:54321'
# Set VITE_SUPABASE_PUBLISHABLE_KEY and SUPABASE_SERVICE_ROLE_KEY locally.
$env:QV_E2E_ISOLATED = '1'
$env:RUN_LIVE_GEMINI_TESTS = '0'
$env:QV_CONFIRMED_FREE_TIER = '0'
npm run test:e2e
Remove-Item Env:QV_E2E_ISOLATED

# Optional destructive reset ONLY of this disposable LOCAL stack:
# & $cli db reset --local --workdir "$stackRoot"
# Normal shutdown preserves local database state:
& $cli stop --workdir "$stackRoot"
```

Do not run `dev:zero-cost` and Playwright on port 5173 simultaneously: Playwright deliberately starts its own isolated server. The prepared app profile keeps AI disabled. Full provider-backed ingestion/answers are not enabled by installing Supabase. Complete remaining Auth/Storage/RLS/worker/deletion/reindex cases in [ISOLATED_SUPABASE_ACCEPTANCE.md](ISOLATED_SUPABASE_ACCEPTANCE.md) using local endpoints and synthetic accounts only; its historical hosted commands are not authorized.

## 6. Zero-cost and security compliance

No inference or embedding requests, billing changes, external paid fallback, model changes, software installations, image/model downloads or hosted modifications occurred. Generation/verification remain configured as Gemini 3.8 Flash and embeddings as Gemini Embedding 001 outside the disabled local profile; nothing was substituted. Free eligibility remains unverified, so live AI tests are skipped/blocked. Existing evidence scope, exact quotations, citation validation, semantic verifier requirements, failure classifications, 15-second verifier budget, retries and concurrency safeguards remain intact.

Mocked tests now use no hosted `.env` or actual service-role credentials by default. Loopback checks execute before any database-writing client is constructed. The local-only request boundary still rejects remote fetches and redirects. This is application-level protection, not an OS firewall; local services/proxies must not forward to hosted resources. Physical host suspension remains outside an application fix.

## 7. Remaining acceptance blockers

1. Download/install approval for the official CLI and local images is absent; full local Supabase migrations/Auth/Storage/scheduler/worker acceptance has not run.
2. No approved local inference/embedding runtime/model. AI remains disabled in the guarded profile; real document ingestion and answer support/latency are unmeasured. Embedding dimensionality/migration requirements from Phase 5 still apply.
3. Gemini account-specific free-tier eligibility/quota remains unverified; no new probes. No paid workaround is permitted.
4. Successful local/mock tests do not establish production readiness. Provider-backed acceptance, backup/recovery checks and remaining dependency-risk review are still required before any separately approved deployment.
