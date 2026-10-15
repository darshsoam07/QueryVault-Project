# Gemini support verifier follow-up

The application architecture, provider and model remain unchanged. **Provider acceptance still fails.** No hosted migrations, push or deployment were performed. See [isolated Supabase acceptance](ISOLATED_SUPABASE_ACCEPTANCE.md) for the required production-critical HTTP/worker checks.

## Diagnosis and actual live results

Inspected `ai@7.0.64`, `@ai-sdk/google@4.0.93`, the native Google provider constructor, model/base URL selection, system/prompt serialization, Gemini thinking options, output cap, deadlines and error paths. Configured model: `gemini-3.8-flash`; endpoint: Google `v1beta` generateContent; `maxOutputTokens=256`; Gemini thinking level low. SDK-internal retries remain zero so retries cannot multiply underneath application retries. The verifier sends only claims with their associated cited passages and the question; no uncited corpus, filename collection or private provider bodies are logged.

Two direct REST probes used only the synthetic constant `Return only SUPPORTED.`:

| Probe | HTTP | Provider classification | Safe diagnostic | Duration |
| --- | --- | --- | --- | --- |
| Configured thinking settings | 503 | UNAVAILABLE | Capacity/high-demand indicator; no Retry-After/RetryInfo | 3028 ms |
| No optional thinking settings | 503 | UNAVAILABLE | Capacity/high-demand indicator; no Retry-After/RetryInfo | 1629 ms |

These reproduce a provider-reported capacity failure without the SDK or verifier prompt, and with/without optional thinking parameters. They do not establish Google's internal infrastructure cause or prove every failed request has the same cause. No invalid-argument/model-not-found response was observed. No provider/model substitution was made.

The final authorized live SDK verifier test ran both synthetic notice-period fixtures and **failed**, not skipped. Supported=false and fabricated=false, with each outcome `timeout`, one attempted request each, 15024 ms and 15015 ms respectively (30039 ms total). No HTTP response status was available for those timed-out attempts. An unavailable verdict is not a successful rejection-quality result. [Final sanitized live evidence](phase2/live-verifier.json), [minimal reproduction](phase2/verifier-minimal-reproduction.json), [minimal control](phase2/verifier-minimal-control.json).

An intermediate live run reported a 210578 ms wall duration on one failed call despite the deadline timer. The cause of the delayed timer was not established; host/event-loop suspension or timing behavior must not be assumed. Explicit wall-clock plus monotonic elapsed checks now run before attempts and after responses, so a late result cannot pass even if timer dispatch is delayed. JavaScript cannot guarantee wall-time response delivery while the host/event loop is suspended. The final run returned at approximately 15 seconds per call.

## Implemented behavior

- `src/lib/retrieval/support-verifier.server.ts`: at most three total attempts, only 429/503 retried, equal-jitter exponential backoff (250–500 ms, then 500–1000 ms absent provider guidance), with a single 15-second budget including waits and calls. Honor Retry-After seconds/HTTP dates and Google RetryInfo delay; if guidance cannot fit, stop closed rather than retry early.
- Two process-local active slots, no waiting-room queue, shared cooldown; a hung transport retains its slot until actual settlement. Abortable waits/calls and explicit elapsed checks prevent late successful verdicts. Cap replica count/project quotas separately because this is not a distributed limiter. At most three provider requests per verifier invocation, unchanged output cap, no retry for unsupported/malformed verdicts or non-transient errors. Failed calls can still incur quota/cost; no zero-cost guarantee is made.
- Structured outcomes: supported, evidence_insufficient, evidence_unsupported, provider_unavailable, provider_invalid_output, timeout, cancelled. Only exact SUPPORTED with an acceptable finish reason passes semantic verification. Cancellation propagates rather than becoming evidence refusal.
- `src/routes/api/chat.ts`: provider failures/timeouts/invalid verdicts produce `503 AI_UNAVAILABLE` before any answer/candidate stream or assistant persistence. Evidence failures retain the grounded refusal. Diagnostics include only status/classification, attempt count, duration and usage metadata. Existing deterministic server-authored numeric-conflict reports remain quote-grounded by construction with both citations; they do not require generation or expanded external disclosure.
- `src/lib/__tests__/verifier-retry.test.ts`: recovery, exhaustion, guidance, shared cooldown, concurrent admission, timeout, cancellation, malformed output and delayed-timer regression coverage.
- `src/lib/__tests__/chat-route.integration.test.ts`: provider-unavailable distinction and no assistant persistence. Existing unsupported-claim/citation tests retained.
- `src/lib/__tests__/provider-live.test.ts`: live acceptance now requires both supported and evidence_unsupported classifications. Two false booleans during an outage cannot pass acceptance.

## Final verification

| Check | Result |
| --- | --- |
| Full Vitest `npm test -- --configLoader native --maxWorkers 1` | 537 passed, 2 opt-in live tests skipped; 32 files passed, 1 skipped |
| TypeScript `npx tsc --noEmit` | Passed |
| ESLint `npm run lint` | No errors; 14 existing warnings |
| Retrieval `npm run eval:gate` | Existing thresholds and 12 deterministic safety checks passed |
| Production `npm run build` | Passed |
| `npm run security:client` | No configured private secret values in public output |
| Separately enabled live verifier | Failed; both synthetic requests timed out; not skipped |
| Full isolated Supabase acceptance | Not run; project/configuration not designated |

An initial fake-clock timeout regression failed because native AbortSignal.timeout was not driven by the fake timer. The deadline now uses a cleaned-up cancellable timer plus elapsed checks; the regression passes without extending test timeouts. Automatic approval review rejected an ambiguous string-based test insertion; an explicit additive patch preserved existing tests. No work remains blocked by that rejection.

## Release prerequisites

1. Working live Gemini verification on the intended model/project: supported fixture must pass, fabricated fixture must produce evidence_unsupported. Capture sanitized duration/status/attempt metadata; do not disable verification or repeatedly probe an unhealthy provider in a tight loop.
2. Designate isolated Supabase credentials/configuration, then execute every applicable item in [ISOLATED_SUPABASE_ACCEPTANCE.md](ISOLATED_SUPABASE_ACCEPTANCE.md). SQL-only tests from the original audit do not substitute for Auth/Storage/scheduler HTTP acceptance. Current credentials are not permission for production writes.
3. Review residual six moderate/seven low dependency advisories, representative real provider load, per-replica concurrency/cost ceilings, container limits and restore procedures.
4. Obtain explicit production approval, backup/restore signoff and a maintenance window. Pause old workers/scheduler; apply migrations in order before the application; restart only compatible workers; reindex legacy PPTX/model metadata; run ownership and consistency checks. Preserve private secrets and default metadata-only diagnostics.

Provider retry guidance: [Google Gemini troubleshooting](https://ai.google.dev/gemini-api/docs/troubleshooting). Model reasoning settings: [Google thinking documentation](https://ai.google.dev/gemini-api/docs/generate-content/thinking).
