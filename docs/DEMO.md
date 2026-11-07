# QueryVault in six minutes

**Presentation mode for this checkout:** run `npm run demo:rehearse -- --headed --debug` from the root. Build before your presentation and give the browser inspector time to open. Step through the three scenarios, or run the command without flags to verify them automatically. The app's compiled UI handles the actions. Local HTTP fixtures supply service responses, including scripted chat text. State that distinction when presenting. The command writes a local fixture build into `.output` and uses port 5197.

**Full-service mode:** the same story can be demonstrated manually once real local Auth, Storage, migrated Postgres, the worker and a validated local model runtime are available. This pass did not verify that complete path. Use the [README](../README.md) for the supported setup and its limits. No credentials or external services are necessary for presentation mode.

## Presenter script

| Time | Action | What to point out |
|---|---|---|
| 0:00–0:45 | Open the three text files in [demo/documents](../demo/documents/). | Two guides describe Harbor Workshop. Meadow is a different event with a different time. The audience can check the facts themselves. |
| 0:45–1:45 | Show the empty library, then upload the guides. In the rehearsal, step through the upload scenario. | The browser queues files and shows per-file state. In a full service run, wait for **Ready** and show page/chunk counts. Explain how the worker parses the private original, embeds chunks and publishes completion. The rehearsal supplies the backend transitions. |
| 1:45–2:30 | Select **harbor-guide.txt**. Ask “What is the Harbor registration reference?” | Expected evidence is **HBR-204**, page 1 of the visitor guide. This is a manual question for a live run. The scripted chat scenario focuses on the next cross-document question. |
| 2:30–3:45 | Select **harbor-guide.txt** and **harbor-travel.txt**; leave **meadow-guide.txt** unselected. Ask “When do Harbor doors open and which entrance is step-free?” | Expect **09:30** from the visitor guide and **east entrance** from the travel guide. Click the second citation and show the filename, page and passage. The rehearsal checks that the request sends exactly the two selected IDs. **13:00** is Meadow's time and does not belong in this answer. |
| 3:45–4:35 | Ask “What is the ticket price?” | None of the documents gives a price. Show the refusal. Explain that a live generation failure is a different condition and should display an error. The browser scenario demonstrates both responses. |
| 4:35–5:25 | Show the upload-failure scenario and refresh the library. | Unsupported and empty files fail. A simulated parser failure leaves the corrupt PDF failed and unavailable for selection. Successful documents remain visible after refresh using the fixture store. |
| 5:25–6:00 | Open a saved citation after refresh, then show the [architecture diagram](../README.md#architecture). | Finish with what ran: browser interactions, parsing/chunking, worker and route checks. Real local database indexing and real model output require the service acceptance run. |

For a scoped live follow-up, select only **harbor-guide.txt** and ask for the Meadow registration reference. Expect a refusal. In a fresh thread, select only **meadow-guide.txt** and ask again. Expected evidence is **MDW-909**, page 1. Starting a fresh thread prevents earlier answers from confusing the comparison. No selection means search all ready documents.

## Verification boundaries

| Flow | Executed | Remaining live check |
|---|---|---|
| Upload and presentation | Compiled browser UI, actual demo file bytes, concurrent queue, empty library, ready/failed counts, refresh and unsupported/empty-file rejection. Storage reservations, upload URLs and polling responses use HTTP fixtures. | Real authenticated Storage write and durable job enqueue. |
| Extraction and indexing | Production parser and chunker on all three files. Worker tests exercise job transitions, chunk submission, failures and retries with storage, embeddings and database boundaries replaced. | Commit vectors and searchable chunks to real Postgres, then refresh and inspect persisted state. |
| Multi-document chat | Browser checks two selected IDs, excludes the third, renders a scripted answer and opens its source. The route integration suite separately exercises actual citation validation, refusal and safe response delivery; offline retrieval tests check cross-document coverage. | Retrieve those two real documents from the database, generate an answer and inspect whether each claim cites the right passage. |
| Missing evidence and failed requests | Browser renders a fixture refusal and a 503 failure; route and worker tests cover backend failures independently. | Repeat against the configured local runtime. |

The DBMS study PDF and formal benchmark are outside this demo. Use only the three included text files. Future work for this showcase is one successful full-service rehearsal on an isolated stack. The larger reviewed benchmark is a separate project goal.

## Rehearsal results, 5 November 2026

| Command | Observed result |
|---|---|
| `npm run demo:rehearse` | Fixture-configured production build passed. All three Chromium scenarios passed in 14.6 seconds. The upload case processed 20 successful browser uploads, including the three demo files, plus three failure cases. |
| `npm test -- --configLoader native --maxWorkers 3` | 694 tests passed, two live-provider tests skipped. `QV_VERIFY_WITHOUT_DOTENV=1` isolated the run from the checkout's dotenv files. |
| `npm run typecheck` and `npm run lint` | Typecheck passed. Lint reported zero errors and 14 existing React Fast Refresh warnings. |
| `bun --no-env-file evaluation/runner.ts --gate` and `bun --no-env-file evaluation/safety.ts` | Both parts of `eval:gate` passed: 13 fixture questions and 12 deterministic safety checks. |

The browser sandbox initially denied connections to localhost. Running the rehearsal with loopback access resolved that environment issue. The launcher builds with fixture values, isolates dotenv loading and uses the installed browser. A regression test checks that a sentinel from a root `.env` cannot enter the fixture build configuration. The demo worker tests also check the submitted document ID and `page_number` on each sample's chunks.

Docker Desktop's Linux engine pipe was unavailable. The prepared Supabase CLI and `.env.zero-cost.local` were absent, and the local-only profile blocks AI requests by design. Actual Auth/Storage writes, vector persistence, live scoped retrieval and generated answers therefore remain unverified. Use the scripted rehearsal for the presentation and describe the live integration accurately.
