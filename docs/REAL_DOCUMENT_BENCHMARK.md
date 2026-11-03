# Real-document RAG benchmark

## Current status

The owner confirmed that no permitted corpus or reviewed questions are available. `evaluation/benchmark/manifest.json` therefore contains **zero real documents and zero questions**, with status `population-pending`. No real benchmark, live provider evaluation, human answer review or production mutation has been performed for this phase.

The framework is implemented separately from the existing 13-case offline retrieval gate. Two explicitly fictional text files and four **unreviewed** example questions under `evaluation/benchmark/sample/` demonstrate the workflow. They must never be relabeled as a reviewed real corpus. Unit tests use synthetic data and mocked adapters; their results validate software contracts, not RAG accuracy.

## Phase 3 readiness check — 2026-11-03

Live execution is **blocked**. `npm run benchmark -- validate evaluation/benchmark/manifest.json --ready` exited 1 with `BENCHMARK_NOT_READY`. Dataset `queryvault-owner-corpus`, version `0.1.0-draft` (schema 1), remains `population-pending`: zero real documents, zero questions and zero reviewer attestations. The synthetic samples are not substitutes for this dataset.

`Test-Path .verification/benchmark-private/local-config.json` returned false. Only the example configuration was inspected; approved provider/model settings and a populated private configuration were not supplied. No alternate private configuration path was provided. `docker ps --filter name=queryvault-benchmark --format '{{.Names}} {{.Status}}'` exited 1 because the Docker Desktop Linux engine pipe was unavailable. Stack isolation, migrations and database emptiness therefore remain unverified. No stack was provisioned, reset or migrated.

All Phase 3 retrieval and generation metrics are **unmeasured (n=0)**; human answer review has not started. No live run or quality report was created, and no provider or database evaluation call was made. This check changed documentation only and preserved existing working-tree changes. The full software test/build suite was not repeated for this blocked readiness check; previous Phase 2 checks are not live baseline evidence.

To unblock: supply permitted originals and provenance, populate the manifest with 60 reviewed questions and the required categories/splits, supply explicit provider-use consent and approved local configuration, and prepare the dedicated disposable stack using the prerequisites below. Re-run `--ready` before any live evaluation. Then verify isolation and execute development and held-out runs separately, followed by human answer review. Do not infer permissions or reviewer attestations from the request to run Phase 3.

## Files and boundaries

| File                             | Responsibility                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `evaluation/benchmark/schema.ts` | Versioned manifest, reference answers, review metadata and readiness requirements                  |
| `load.ts`                        | Production extraction, raw/extraction hashes, exact spans, path boundaries and leakage checks      |
| `metrics.ts`                     | Source alignment, retrieval metrics, explicit measurement states and aggregates                    |
| `local.ts` / `isolation.ts`      | Disposable local Supabase adapter, production worker/retrieval/chat integration and network guards |
| `run.ts`                         | Per-question execution, provenance and separate retrieval/answer results                           |
| `review.ts`                      | Bind human judgments to the dataset, run and exact generated answer                                |
| `main.ts` / `cli.ts`             | Sanitized process entry, commands and private artifact output                                      |

No production retrieval, chunking, reranking, generation, database architecture, model provider or dependency is replaced. The runner creates an admitted document reservation, uploads the original to private Storage, enqueues an authenticated job and drains the **actual production worker**. The worker performs parsing, chunking, embedding and atomic indexing. This is not a browser-upload/server-function transport test. Retrieval uses `createLiveDeps` and `runRetrieval`; generation invokes the existing `/api/chat` handler in-process with a real local user token and consumes its validated response stream.

## Prepare the owner's corpus

Run commands from the repository root. Use `npm run benchmark -- ...`; it invokes Bun with `--no-env-file` and clears inherited app/provider variables before configuration modules load. Do not invoke internal modules as alternate live entry points.

Keep private originals, manifests, config and judgments in `.verification/benchmark-private/` (already Git-ignored), or store the input corpus in a separately protected local folder. Never put them in `public/` or client source. Outputs always go to `.verification/benchmark-private/` and are created without overwriting existing artifacts. JSON results can contain source spans, returned citations and answers; treat them as private. File mode 0600 is requested; Windows permissions inherit the directory ACL, so the owner must protect that directory.

For each supported document:

```powershell
npm run benchmark -- prepare .verification/benchmark-private/corpus/manual.pdf
```

This runs the existing parser without a database or model and writes a private extraction artifact containing the raw-file SHA-256, extraction SHA-256, parser output and span convention. It does not create provenance or review attestations for you. Copy the hashes into the corpus manifest and inspect the extracted text against the original, especially PDF tables, layout, spreadsheets and slide ordering. Unsupported/binary/empty input is rejected by existing parser checks.

Copy the empty real manifest into your corpus folder and populate it there. `documents[].file` is relative to that manifest; originals must resolve inside its directory, including after symlink resolution. Absolute paths and traversal are rejected. Documents with identical raw hashes cannot be registered under different IDs.

## Manifest format

### Phase 3C collection progress

Verified on 2026-11-03: 66 benchmark tests passed; typecheck and `eval:gate` passed; lint had zero errors and 14 existing warnings. The tracked manifest's progress/draft checks passed as incomplete, readiness exited 1 (`BENCHMARK_NOT_READY`), and reporting the invalid blank worksheet exited 1 with a sanitized error. Real documents, questions, spans and reviews remain zero. No live evaluation or database operation occurred.

After adding structurally complete draft records, run this read-only local command:

```powershell
npm run benchmark -- progress .verification/benchmark-private/corpus/manifest.json
# The empty tracked template can also be inspected:
npm run benchmark -- progress evaluation/benchmark/manifest.json
```

It reuses full draft validation: schema, source paths, raw/extraction hashes, exact UTF-16 spans and existing leakage checks. Invalid input exits nonzero through the existing sanitized error handler and produces no success/count report. A valid but incomplete draft exits zero with `datasetReadiness: "not-ready"` and readiness issue codes. Use `validate ... --ready` for an enforcing readiness gate; progress is not a replacement for that command.

The JSON contains a dataset hash, real/sample label, document/question/span counts, category-by-split counts and targets, provider-use permission counts, and pending/reviewed-attestation/change-request counts. Evidence spans count annotations (including references to the same evidence in different questions), not unique source passages. Changes-requested counts overlap pending counts. Reviewed attestations are not authenticated reviewer identities. The report never asserts semantic answer support, live environment readiness or live evaluation success.

The output omits source filenames/paths, text, questions, reference answers, evidence quotes, author/reviewer identities and free-text provenance. No artifact is written automatically. If retaining progress snapshots, save them under the ignored private directory with a new filename; do not overwrite prior snapshots. Collection counts and hashes can still be sensitive organizational metadata. No provider credentials, model calls or database connections are needed.

Continue the existing sequence below: permitted originals in the private corpus directory, explicit provenance/permissions, `prepare` and extraction inspection, source-grounded question/span authoring, independent reviewer signoff, draft validation and readiness validation. No collection or review content is generated by `progress`.

### Phase 3B independent dataset signoff

Verification on 2026-11-03: `npm test -- --configLoader native src/lib/__tests__/benchmark.test.ts src/lib/__tests__/benchmark-local.test.ts` passed 63 tests; `npm run typecheck` passed; `npm run lint` completed with zero errors and 14 existing warnings; `npm run eval:gate` passed the offline retrieval gate and 12 deterministic safety checks. Draft validation of the tracked manifest returned `valid-draft-not-ready`; the same command with `--ready` exited 1 with `BENCHMARK_NOT_READY`. All six categories and both splits remain at zero questions; documents, evidence spans and completed reviews are also zero. No live evaluation or database operation occurred.

The owner reconfirmed during Phase 3B that no permitted real-document corpus or independent reviewer judgments have been supplied, and requested that the dataset remain empty and unreviewed. The documented private corpus manifest was absent at inspection. No documents or reviewer identities were synthesized to fill it.

For each document and question, an actual independent reviewer must inspect the record and supply `review.author` (the person who prepared the document record or authored the question), `review.reviewer`, `review.reviewedAt` (ISO UTC), `review.decision: "approved"`, and nonempty `review.notes` before `review.status` can be `reviewed`. Use consistent identity strings; the normalized author and reviewer must differ. The blank worksheet contains these fields but does not pre-approve anything. Existing completed records with only a name/time must obtain the missing judgment; do not mechanically fill it in.

Document notes should describe extraction fidelity and permission/provenance checks. Question notes should explain why every reference/accepted answer is supported by the cited spans, or why an unanswerable fact is absent after checking the whole corpus. Include the independent leakage review: duplicated facts/answers and semantic paraphrases must remain within one split, including facts repeated in different documents. A reviewer finding an unsupported answer or leakage keeps the record `pending` with `decision: "changes-requested"` and records corrections in notes. After corrections, obtain a new review; never carry old approval onto edited evidence or answers.

Validation rejects missing signoff fields, self-review, non-approved completed reviews and common placeholders (such as `TBD`, `TODO`, `Your Name`, `REPLACE_WITH_REVIEWER`, and angle-bracket markers). Required provenance fields also reject those markers. Every question, including negative cases, needs a nonempty reference answer/refusal explanation. Pending records can remain partial in review metadata; omit unset optional fields instead of inserting blanks/nulls.

These checks validate attestations, not authenticated identity or semantic entailment. Exact spans prove where text occurs, not that it supports an answer. Existing duplicate-question, leakage-group, overlapping-span and lexical-similarity checks cannot detect all answer leakage or paraphrases. Unsupported reference answers and semantic leakage require the independent human judgments above; neither a local string heuristic nor a runtime model verifier substitutes for that review. Do not claim readiness proves the truth of a falsely supplied signoff.

Completion sequence: place permitted originals in the ignored corpus directory; run `prepare` and inspect extraction; populate sources/questions using the worksheet; run draft validation; obtain independent record reviews and the dataset-wide split review; set the manifest to `reviewed`; then run the readiness command below. Keep held-out annotations restricted to the evaluator/reviewer, and keep all originals, filled worksheets and judgments private. Do not upload reference answers, manifests or gold spans as runtime corpus evidence.

```powershell
npm run benchmark -- validate .verification/benchmark-private/corpus/manifest.json
npm run benchmark -- validate .verification/benchmark-private/corpus/manifest.json --ready
```

The checked-in readiness check remains `npm run benchmark -- validate evaluation/benchmark/manifest.json --ready`; it must fail while that manifest is empty. A separate private manifest must be validated at its actual path and reported separately, never confused with the empty tracked template. Stop here: dataset readiness does not authorize live evaluation.

### Phase 3A onboarding and blank worksheet

Phase 3A verification on 2026-11-03: the two benchmark test files passed all 56 tests; typecheck and the offline evaluation/safety gate passed; lint reported zero errors and 14 existing warnings. Sample `prepare` succeeded without marking anything reviewed. The real manifest remains version `0.1.0-draft`, with zero documents/questions/reviews: draft validation passed and `--ready` correctly failed with `BENCHMARK_NOT_READY`. No live evaluation or database operation occurred.

The existing `prepare` and `validate` commands need neither Docker nor provider credentials. The [blank worksheet](../evaluation/benchmark/authoring-template.json) contains empty fields, pending reviews and a suggested category allocation. It is deliberately **not a valid manifest**. Never replace this tracked template with private content or count placeholder questions as completed work.

Create a private workspace and copy the empty manifest and worksheet without overwriting existing files:

```powershell
New-Item -ItemType Directory -Force .verification/benchmark-private/corpus
git check-ignore .verification/benchmark-private/corpus/manifest.json
node -e "const fs = require('node:fs'); fs.copyFileSync('evaluation/benchmark/manifest.json', '.verification/benchmark-private/corpus/manifest.json', fs.constants.COPYFILE_EXCL)"
node -e "const fs = require('node:fs'); fs.copyFileSync('evaluation/benchmark/authoring-template.json', '.verification/benchmark-private/corpus/worksheet.json', fs.constants.COPYFILE_EXCL)"
```

The ignore check should print the private path; stop if it does not. Git ignore is not encryption or access control: restrict directory access and backups, and never force-add these files. Place permitted originals inside this corpus directory, optionally under `documents/`. Manifest paths use forward slashes, such as `documents/manual.pdf`; no absolute paths, backslashes or links outside the corpus root. A changed/redacted source requires new extraction, hashes, dataset version and review.

Local extraction supports text-bearing PDF, DOCX, TXT, MD/MARKDOWN, CSV, HTML/HTM, XLSX and PPTX, with a 25 MiB file maximum. The upload policy also recognizes PNG/JPG/JPEG/WEBP, but the local parser does not perform OCR. Images and image-only documents cannot silently become usable evidence. Parser limits can truncate text, including long pages and worksheet rows; inspect extraction completeness rather than assuming all original content was retained.

1. Run `npm run benchmark -- prepare .verification/benchmark-private/corpus/documents/manual.pdf` for each actual original. Use the returned artifact path; do not guess its timestamp.
2. Compare `pages[].text` with the original, especially table headings, numbers, slide order, encoding and omissions. Do not author spans for text missing from extraction.
3. Copy the worksheet's `document` object into the private manifest's `documents` array. Assign a stable ID and relative file path; copy both hashes from the extraction artifact. Fill actual origin, permission/license basis, supplier and receipt timestamp. Keep `providerUseAllowed: false` unless the owner explicitly permits disclosure to the intended provider; record the provider/scope in the permission description. Local processing permission does not imply provider permission.
4. Keep `review: { "status": "pending" }` until actual review. Do not populate empty reviewer/date placeholders. Resolve required blanks/nulls before draft validation. Omit optional empty `gradingNotes` or review `notes` rather than submitting empty strings.
5. Set private manifest status to `draft`. Copy completed question objects into `questions`; allocation/helper objects do not belong in the manifest. Keep the checked-in empty manifest unchanged.

### Author questions and verify UTF-16 spans

Use the worksheet's `question` and `supportingSpan` objects. Stable IDs use lowercase letters, digits, hyphens or underscores. Choose category, independent difficulty and split explicitly. Assign the same leakage group to questions about the same underlying fact, even when wording differs.

For answerable cases set `answerable: true`, `expectedRefusal: false`, write a source-verified reference and include all required spans. Each span identifies its document; no separate document-ID list is needed. Multi-hop requires at least two distinct spans; include multiple documents for multi-document cases and explain the reasoning chain in `gradingNotes`. Accepted alternatives must be source-supported. For `unanswerable`, set `answerable: false`, `expectedRefusal: true`, empty spans/accepted answers, and describe the absent fact and expected refusal in the reference/grading notes after checking the entire corpus. Adversarial cases in this schema remain answerable with malicious query/source instructions; do not alter originals to manufacture a case.

Use JavaScript string offsets, not bytes, code-point counts or visually counted characters. In a local Node REPL (`node`), use this recipe with actual private extraction values. Keep the session/output private:

```javascript
const fs = require('node:fs');
const extraction = JSON.parse(fs.readFileSync('ACTUAL_PRIVATE_EXTRACTION_PATH', 'utf8'));
const documentId = 'ACTUAL_DOCUMENT_ID';
const pageNumber = 1; // Choose the actual parser page/slide/sheet position.
const page = extraction.pages.find(p => p.page === pageNumber);
if (!page) throw new Error('Page not found');
const quote = ''; // Paste exact evidence, preserving whitespace and newlines.
if (!quote.trim()) throw new Error('Supply an actual nonempty quote');
const start = page.text.indexOf(quote);
if (start < 0) throw new Error('Quote not found verbatim');
if (page.text.indexOf(quote, start + 1) !== -1) throw new Error('Repeated quote: inspect surrounding text to select the intended occurrence');
const end = start + quote.length;
if (page.text.slice(start, end) !== quote) throw new Error('Span mismatch');
JSON.stringify({ documentId, page: page.page, start, end, quote }, null, 2);
```

For repeated text, inspect surrounding text to select the correct occurrence or use a uniquely identifying longer passage; never automatically choose the first match. An emoji outside the basic multilingual plane occupies two UTF-16 units. Do not normalize spaces, line endings or Unicode in the quote. Validation independently re-extracts the original and checks the slice and both hashes.

### Reviewer checklist and readiness levels

- Confirm actual provenance/local processing permission for each original, and separately confirm provider-use permission where applicable.
- Verify extraction fidelity, both hashes, all spans and reference facts against originals. Check negatives against the full corpus.
- Confirm exactly 60 questions with the category totals below, exactly 40 development and 20 held-out, and every category in both. The worksheet supplies a concrete allocation.
- Review semantic paraphrases beyond the lexical detector. Keep related evidence/leakage groups within one split. Reserve held-out annotations before tuning and restrict access; JSON alone cannot enforce access control. Do not merely reword leaking questions to evade detection.
- Only the actual reviewer supplies their identity and ISO UTC timestamp (`YYYY-MM-DDTHH:mm:ssZ`) after checking a record, then sets it to `reviewed`. Set the manifest to `reviewed` only after all record signoffs and split review. These are attestations, not authenticated signatures.
- Version the dataset after source, answer, span, split or review changes and rerun validation. Dataset review is distinct from human scoring of future generated answers.

Draft validation checks field shapes, provenance, paths, hashes, exact spans, duplicates and cross-split leakage. Pending reviews and incomplete counts are allowed but reported; blank worksheet fields are not valid draft records. Dataset readiness (`--ready`) additionally requires the fixed allocation and completed reviews:

```powershell
npm run benchmark -- validate .verification/benchmark-private/corpus/manifest.json
npm run benchmark -- validate .verification/benchmark-private/corpus/manifest.json --ready
```

Neither command proves environment readiness or provider approval, nor makes model/database calls. Live readiness separately requires the isolated environment and explicit provider settings/permissions below. Do not run `run --live` during corpus preparation. Keep reference answers/gold spans in private scoring annotations, never in uploaded originals or question text. The existing adapter sends originals and questions, not references/spans. Never upload the manifest or worksheet as corpus evidence.

`schemaVersion: 1` describes the format. `datasetId` is stable; increment `version` whenever source content, questions, references, review decisions or splits change. The dataset hash covers canonical manifest content, including document/extraction hashes and review metadata. Raw bytes and freshly extracted text must match their hashes every time the manifest loads.

Each document records:

- Stable `id`, relative `file`, `sha256`, `extractionSha256`.
- `provenance.kind: "owner-supplied"`, a genuine `origin`, the permission/license basis, `suppliedBy`, ISO `receivedAt`, and explicit `providerUseAllowed`.
- `review.status: "pending" | "reviewed"`; completed dataset reviews require distinct author/reviewer identities, ISO `reviewedAt`, `decision: "approved"` and review notes, as described in Phase 3B above.

Provenance validation checks required attestations and content identity. It cannot independently establish legal permission, truthfulness of an attestation or whether a person actually reviewed the file. The owner/reviewer must supply and verify those facts. Nothing automatically assigns a reviewed status.

Each question records:

- Stable `id`, `question`, `referenceAnswer`, optional `acceptedAnswers` and `gradingNotes`.
- Independent `category` and `difficulty` (`easy`, `medium`, `hard`).
- `split` (`development`, `held-out`) and a `leakageGroup` shared by paraphrases or questions testing the same fact.
- `answerable`, `expectedRefusal`, `supportingSpans`, and review metadata.

Each span has `documentId`, parser `page`, `start`, `end`, and `quote`. Offsets are **UTF-16 positions in the exact extracted page text**, zero-based start and exclusive end, using JavaScript `text.slice(start, end)`. They are not PDF byte positions. Page means the parser's position: physical PDF page, slide or worksheet position where applicable; plain text has one parser position. The slice must exactly equal `quote`. Do not hand-estimate offsets or substitute reconstructed text. Chunk IDs are not gold labels, so the benchmark can survive future chunk-boundary changes.

Answerable questions require a non-empty reference and supporting spans. Negatives require `answerable: false`, `expectedRefusal: true`, category `unanswerable`, no supporting spans and no accepted factual answer variants. Use a refusal explanation/reference and grading notes to identify the absent fact or near miss. Multi-hop questions need at least two supporting spans. Adversarial questions in this schema are answerable factual requests with malicious source/query material; refusal-only attacks belong in `unanswerable` with explanatory notes.

Reference answers and gold spans are used only by scoring/review. The adapter receives document originals and question text; references are never added to retrieval or generation context.

## Review and split workflow

The initial readiness profile requires 60 reviewed questions:

| Category                               | Total | Suggested development / held-out |
| -------------------------------------- | ----: | -------------------------------: |
| `factual`                              |    15 |                           10 / 5 |
| `semantic`                             |    10 |                            7 / 3 |
| `exact` (identifiers, numbers, tables) |    10 |                            7 / 3 |
| `multi-hop` (including multi-document) |    10 |                            6 / 4 |
| `unanswerable` (including near misses) |    10 |                            7 / 3 |
| `adversarial`                          |     5 |                            3 / 2 |
| Total                                  |    60 |                          40 / 20 |

The gate enforces exactly 60 questions with these category totals, exactly 40 development and 20 held-out questions, and every category in each split. Category and difficulty remain independent. Review difficulty distribution as part of signoff; results report both groupings. These counts are a versioned initial policy, not evidence that 60 cases establish production generalization.

1. The author drafts questions, references and spans directly from permitted documents.
2. A reviewer verifies the answer against the original and extracted text, confirms span completeness and checks negative cases across the entire corpus.
3. Assign related questions to one leakage group **before** splitting. Reserve the held-out set before tuning.
4. The validator rejects duplicate normalized question text, shared leakage groups across splits, overlapping gold spans across splits and cross-split token Jaccard similarity >= 0.8. Investigate a similarity rejection and reassign related cases to one split or redesign the dataset with reviewed distinct facts. Do not reword the same fact to evade detection.
5. A human checks semantic paraphrases that lexical similarity cannot detect. Do not tune against held-out answers. Keep held-out annotations access-controlled; the local JSON format alone cannot prevent a developer reading them.
6. Only after review, set document/question records and the manifest to reviewed and version the result. Re-run validation after any change.

```powershell
# Structural validation permits drafts and reports readiness gaps.
npm run benchmark -- validate evaluation/benchmark/sample/manifest.json
npm run benchmark -- validate .verification/benchmark-private/corpus/manifest.json
# Release readiness fails closed on missing reviews, categories or counts.
npm run benchmark -- validate .verification/benchmark-private/corpus/manifest.json --ready
```

The checked-in empty real manifest and sample both intentionally fail `--ready`. Draft validation success is not benchmark completion.

## Isolated live execution prerequisites

The runner never links, provisions, resets, migrates or deletes a database. Prepare a **fresh dedicated local Supabase stack** with all repository migrations and a private documents bucket, project ID `queryvault-benchmark`. Do not reuse a development or deployed project. Any existing documents, jobs, threads, messages, Auth users or Storage objects block execution before creating a benchmark user.

The adapter verifies running Docker containers named `supabase_kong_queryvault-benchmark` and `supabase_db_queryvault-benchmark`. The API must be published explicitly on `127.0.0.1`, matching the configured port; wildcard bindings, host bind mounts and remote URLs are rejected. Only volume/tmpfs mounts are accepted. This may require a dedicated local setup rather than an unmodified existing CLI configuration. Container names are an operational guard, not proof against a malicious local administrator. Do not point the local API at a remote database/upstream. Disable Vault/cron worker targets and unrelated workers for the isolated run; use only the in-process benchmark worker.

All original documents must explicitly permit submission to the chosen provider. Even **retrieval-only live evaluation makes embedding requests**, and optional configured retrieval features may make additional calls. `--live` is required for any live execution; `--generate` additionally enables production chat and support verification. No live calls are made by `prepare`, `validate`, unit tests or the old offline gate.

Copy `evaluation/benchmark/local-config.example.json` to a protected location and replace every placeholder with **local** Supabase credentials and explicitly approved provider/model settings. Required fields:

- `projectId`, `supabaseUrl`, `publishableKey`, `serviceRoleKey`.
- `provider` contains allowlisted existing production environment-variable names, such as `AI_PROVIDER`, `GEMINI_API_KEY` (or the selected provider's existing key variable), `AI_CHAT_MODEL`, `AI_UTILITY_MODEL`, `AI_EMBEDDING_MODEL`, `AI_EMBEDDING_DIMENSIONS`. Use the existing 3072-dimensional schema contract. No new provider is introduced.

The runner maps the local values to `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_PROJECT_ID`, and sets `QV_TRACE_CONTENT=0`. It does not read the project's `.env` or use inherited credentials as fallback. Network requests are restricted to the local API origin and explicitly configured provider origin; redirects are rejected. Console output contains status/hash/counts/artifact path, not source content, answers or raw provider/database errors.

```powershell
# Actual production ingestion + retrieval, without answer generation:
npm run benchmark -- run .verification/benchmark-private/corpus/manifest.json --config .verification/benchmark-private/local-config.json --split development --live

# Use another fresh stack for each run. Add validated production chat:
npm run benchmark -- run .verification/benchmark-private/corpus/manifest.json --config .verification/benchmark-private/local-config.json --split held-out --live --generate
```

Data remains in the disposable stack for inspection after success/failure. Teardown is an explicit owner operation; the runner does not clean up an arbitrary database. A failure during ingestion stops setup and records an unavailable run; there is no claim that partial ingestion evaluated the full corpus. Production retry policy still applies; a queued retry causes this benchmark run to fail rather than wait indefinitely or label incomplete ingestion successful. Existing application rate limits remain active and can produce unavailable cases; record them, then repeat on a freshly prepared stack with an approved execution schedule.

## Results and metric meanings

Private JSON reports contain dataset ID/version/hash, run ID, timestamp, Git revision, working diff hash, full source snapshot hash (including new implementation files), lockfile hash, chat/verifier source hashes as prompt/config identities, parser/chunker/worker versions, runtime versions, retrieval config, resolved provider/model IDs, runtime document/chunk IDs, source mappings, latency and stage-specific errors. Provider-internal model revision is null unless exposed; a model alias is not a frozen provider revision.

Every metric has `status`, `value`, and sample count. Status is `measured`, `skipped`, `unavailable` or `unmeasured`. Non-measured values are null, never a fabricated zero or perfect score. Aggregates include measured n, total, unavailable, unmeasured and skipped counts; averages cover measured rows only. Missing retrieval/mapping results or operation failures mark execution incomplete and return nonzero. There is no blanket answer-quality PASS based on successful execution.

Retrieval scoring uses gold span overlap to identify relevant **indexed chunks**. It reports Recall@5, Precision@5, MRR, binary nDCG@5, required-document coverage in top 5, indexed gold-span coverage, and final-context gold-span coverage. Precision divides by five even when fewer results exist. Recall over indexed chunks must be read with indexed coverage: if ingestion loses one gold span but keeps another, retrieval recall alone can look good. If all gold evidence is lost, recall is zero. Gold-span coverage requires complete interval coverage, including adjoining pieces. Negative cases have no retrieval relevance denominator and are skipped.

Mapping strips only the production section prefix and tolerates whitespace normalization while retaining exact source offsets/quotes. Noncontiguous table/context lines can map separately. Ambiguous repeated text or transformations that cannot be mapped exactly are unavailable, not invented offsets. This deliberately makes difficult layouts fail closed; extending alignment is future work.

Generation reports record the **delivered production answer**, returned citations, refusal outcome and latency. These are not raw pre-validation model answers. False refusal and negative refusal accuracy are measured from delivered responses; HTTP/provider failures are unavailable. A supplementary normalized reference exact-match metric is explicitly not semantic correctness.

The production chat handler reruns retrieval. Its returned source list contains cited evidence only; the separately measured retrieval pass is not claimed to be the exact context of generation. Full generation context and token usage are explicitly unavailable because the handler does not expose them. No production hook was added solely to manufacture those measurements.

Semantic correctness, faithfulness, citation support, citation coverage, completeness and relevance remain **unmeasured until human review**. There is no RAGAS/LLM judge in this phase. This avoids grading answers with the same runtime verifier and calling it independent quality evidence.

## Human answer review

Join the run and original reviewed manifest by question ID, checking `datasetHash`. Review the question, reference, gold spans, delivered answer and returned cited snippets. `human-v1` uses scores in [0,1] with a written rationale:

- Correctness: fraction of required reference facts answered correctly; unsupported contradictions reduce the score.
- Faithfulness: fraction of factual claims supported by **returned cited evidence**. This is narrower than full-generation-context faithfulness.
- Citation support: fraction of claim/citation associations whose cited text actually supports the claim.
- Citation coverage: fraction of factual claims carrying a supporting citation.
- Completeness: fraction of required answer aspects covered.
- Relevance: fraction of answer content directly addressing the question.

For negative cases, use refusal accuracy for automatic scoring; the reviewer should document their convention for non-factual refusals and zero claim denominators rather than treating an empty answer as perfectly faithful. Do not enter a semantic score that was not actually reviewed. Partial review is supported and remains partial in the report. Reviewer identity/time are attestations, not authenticated signatures; independent secondary spot-checking is recommended.

A judgment file has `schemaVersion: 1`, `rubricVersion: "human-v1"`, `runId`, `datasetHash`, and `judgments`. Each judgment contains `questionId`, the run's `answerHash`, reviewed metadata, all six named numeric `scores`, a non-empty `rationale`, and `evidenceScope: "returned-citations-only"`. The loader rejects duplicate judgments, unknown/stale answers, pending review metadata and non-live run scopes.

```powershell
npm run benchmark -- review .verification/benchmark-private/run-TIMESTAMP.json .verification/benchmark-private/judgments.json
```

Reviewed aggregates are a separate artifact. The original run remains unchanged. Mocked/synthetic unit-test run records cannot be submitted as live quality evidence.

## Verification and Phase 3 prerequisites

```powershell
npm test -- --configLoader native src/lib/__tests__/benchmark.test.ts src/lib/__tests__/benchmark-local.test.ts
npm run typecheck
npm run lint
npm run eval:gate
```

Before Phase 3 quality/optimization claims: obtain permitted originals and 60 reviewed questions, complete held-out leakage review, provision the verified disposable stack, explicitly approve provider use, execute real ingestion/retrieval/chat runs, inspect unavailable alignments/errors and complete human scoring. Then compare one pipeline variable at a time and consider a pinned independent judge. Capture full generation context and token usage through a reviewed integration if those measurements become necessary. Existing offline CI remains useful but does not substitute for these prerequisites.
