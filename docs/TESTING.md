# Testing

## Local checks

```bash
npm test
npm run typecheck
npm run lint
npm run eval:gate
npm run build -- --configLoader native
npm run security:client
```

Use the current test runner summary for counts. Live-provider tests are opt-in and may be skipped; a green offline suite does not establish live provider or deployed database health. Lint currently includes React Fast Refresh warnings about mixed component/helper exports.

On Windows, if the sandbox denies temporary-file renames, point `TEMP` and `TMP` at a writable workspace directory before running tests. Native config loading can avoid Windows config-bundling problems. A build with `QV_ALLOW_PLACEHOLDER_CONFIG=1` and placeholder public configuration is a verification artifact and must not be deployed.

## What each layer proves

| Layer                             | Coverage                                                                                                       | Boundary                                                                                                                                        |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Vitest unit/component/route tests | Ingestion, chunking, auth, cancellation, retries, citation validation, verifier behavior, UI and configuration | External services are mocked except explicit live opt-ins.                                                                                      |
| `rls.test.ts`                     | Static migration-policy and service-role scoping invariants                                                    | Does not execute PostgreSQL or prove deployed RLS enforcement.                                                                                  |
| `npm run test:db`                 | SQL behavior on a disposable local PostgreSQL/pgvector container                                               | Requires a running Docker engine and `QV_DB_TEST_CONTAINER=queryvault-phase2-*`; script verifies isolation. Does not test the deployed project. |
| `npm run test:e2e`                | Browser flows with mocked service boundaries                                                                   | Database-writing pagination case requires explicitly isolated local setup; inspect skips and startup failures.                                  |
| `npm run eval:gate`               | Offline fixture retrieval plus deterministic safety contracts                                                  | No document ingestion, real embeddings, PostgreSQL retrieval or generated answers.                                                              |
| Live provider opt-ins             | Synthetic embedding/support-verifier checks                                                                    | Not a real-document answer-quality benchmark.                                                                                                   |
| Build and bundle scan             | Compilation and configured secret-value leakage detection                                                      | Not deployment or end-to-end acceptance.                                                                                                        |

## Offline RAG benchmark

`evaluation/dataset.ts` contains 13 synthetic questions over the 15 prewritten chunks in `evaluation/fixtures.ts`. Labels identify relevant chunks and required documents, not reference answers. There are three factual, two semantic, two cross-document, one multi-hop, three negative and two injection cases.

The runner uses hand-written topic vectors and lexical overlap in place of real retrievers, then exercises production fusion, heuristic reranking, evidence gating and context construction. It reports Recall@5/10, Precision@5, MRR, nDCG@10 and evidence precision on answerable cases. Negative-category ranking metrics are omitted (N/A) because those cases have no relevant chunks.

Structural metrics are explicitly scoped:

- `evidence_ids_valid`: context source IDs are well-formed and unique, and chunks/documents belong to the ranked candidates. This replaces the old simulated `citation_validity` metric; values are not semantically comparable.
- `evidence_marker_containment`: forbidden markers present in context remain inside evidence elements. This replaces `injection_defense`; it does not measure model obedience to malicious text.
- `retrieval_refusal_accuracy`: refusal on retrieval-stage negatives only (currently two). This replaces `refusal_accuracy` to make the scope explicit.
- `generation_negative_cases_unmeasured`: near-miss negatives requiring generation evaluation (currently one); not counted as passed refusals.
- `cross_document_coverage`: required documents appear in final context; gated at 1.0.

JSON reports include `scope` and `unmeasured`. Consumers must migrate the renamed keys; there are no misleading legacy aliases. Answer correctness, faithfulness, generated citation support, model injection resistance and generation-stage refusal are unmeasured. The runtime semantic support verifier is a separate guard and does not turn the offline runner into an answer benchmark.

`evaluation/thresholds.json` enforces finite scores in [0,1], minimum case counts (13 total and each category's existing count), category presence, consistent aggregate counts and quality floors/ceilings. Dataset validation rejects duplicate IDs/labels, unknown chunk references, empty questions/markers, contradictory refusal labels and incomplete required-document labels. Both retrieval- and generation-stage negative labels must remain represented. These counts preserve the current regression set; they do not satisfy a 50-question real-document benchmark.

`evaluation/safety.ts` separately checks deterministic quote, citation, scope, conflict and evidence-delimiter contracts. It does not score model answers.

```bash
npm run eval
bun evaluation/runner.ts --json
npm run eval:gate
```

## Short-fact ingestion change

Chunker version 4 preserves standalone facts, numbers and identifiers regardless of length, including non-Latin letters/numbers. Recursive text splitting discards empty and punctuation-only fragments. Page and heading metadata remain attached to each chunk. Regression tests cover short pages, sections, trailing facts and blank/noise input.

Upload admission now rejects zero-byte files rather than all files below 100 bytes. The worker rejects empty extracted text rather than all documents below 40 characters. Format/signature, encoding, maximum-size and usable-chunk checks remain in place. Worker regression tests verify short content reaches indexing and empty/noise input fails before embedding, using mocked services.

The version bump separates new deterministic chunk IDs from version 3. Existing indexed documents do not automatically regain omitted facts: they must be reprocessed through the normal ingestion/reindex workflow after deployment. No reindex or database mutation is part of this source change. Historical reports describe their original versions and should not be interpreted as current acceptance evidence.

## CI and remaining evaluation work

`.github/workflows/ci.yml` runs typecheck, lint, offline tests, the evaluation/safety gates, a placeholder verification build, boot validation and a bundle secret check. It does not currently run the database or browser suites or live answer-quality evaluation.

A reviewed 50+ question real-document benchmark, reference answers, difficulty labels, controlled retrieval/chunking/reranking comparisons, live answer scoring and human review remain separate future work. Do not present fixture results as production accuracy or a hallucination-free guarantee.
