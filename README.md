# QueryVault

A multi-tenant RAG (Retrieval-Augmented Generation) document assistant. Upload PDFs, ask questions, get streamed answers grounded in your own documents with page-level citations — or an honest refusal when the documents don't actually contain the answer.

Built to explore a question most RAG tutorials skip: **how do you stop the system from confidently answering when it shouldn't?** The retrieval pipeline includes a pre-generation evidence gate, server-side citation validation, and a CI-gated evaluation harness measuring retrieval quality and prompt-injection resistance — not just "does it answer."

## Evaluation results

Run offline, no API keys or network required (`bun evaluation/runner.ts`), against a 13-case golden set covering factual lookup, semantic paraphrase, cross-document, multi-hop, refusal (negative), and prompt-injection categories:

| Metric | Result |
|---|---|
| Recall@5 | 1.00 |
| Recall@10 | 1.00 |
| MRR | 0.925 |
| nDCG@10 | 0.950 |
| Citation validity | 1.00 |
| Refusal accuracy | 1.00 |
| False refusal rate | 0.00 |
| Injection defense | 1.00 |

CI-gated: `bun evaluation/runner.ts --gate` exits non-zero if any metric drops below its floor in `evaluation/thresholds.json`, so a retrieval regression fails the build instead of shipping quietly.

74 unit/integration tests pass (`npx vitest run`) covering retrieval math, ingestion idempotency, and security-relevant behavior (tenant isolation, citation forgery, injection payloads).

*Note: the eval corpus is a small fixture set (13 cases), not a large benchmark — treat these numbers as a regression signal, not a claim of production-scale accuracy.*

## Architecture

```
Browser
  │
  ├─ Upload ──► Storage (per-user path) ──► durable job queue (SKIP LOCKED)
  │                                              │
  │                              validate → parse → chunk → embed → index
  │
  └─ Chat ────► auth check ──► retrieval pipeline ──► evidence gate ──► LLM (streamed)
                                     │                      │
                          dense + lexical → RRF fusion   grounded? generate
                                → rerank                 not grounded? refuse
```

**Retrieval**: hybrid dense (pgvector/HNSW) + lexical (Postgres full-text) search, merged with Reciprocal Rank Fusion (score-incomparable retrievers aren't blended by raw number), then reranked (LLM listwise scorer with a deterministic heuristic fallback if the reranker call fails).

**Grounding**: before any generation call, an evidence gate checks top similarity/rerank score and supporting-chunk count. If it fails, the system returns a fixed refusal string — no LLM call, no chance to hallucinate an answer from weak evidence.

**Citations**: the model must cite evidence by id (`[source_01]`); citations are validated server-side against the actual retrieved set before being persisted or rendered, so a model can't invent a source that doesn't exist.

**Tenant isolation**: Postgres RLS on every table, *plus* the retrieval SQL functions independently re-check `auth.uid() = requesting_user_id` — so even a bug that passed the wrong user id from the application layer would still be rejected by the database.

**Ingestion**: idempotent job queue — deterministic chunk UUIDs (same document + pipeline version + position always yields the same id), so a retried or crashed job upserts instead of duplicating. Exponential backoff with jitter on transient failures; stale-version chunks pruned after a successful reprocess.

See [`DESIGN.md`](./DESIGN.md) for the reasoning behind these decisions.

## Stack

TanStack Start, TypeScript, React, Tailwind, Postgres (pgvector, full-text search, RLS), Vitest.

## Development

```sh
npm i
npm run dev       # app
npm run test      # unit + integration tests
npm run eval      # retrieval evaluation report
npm run eval:gate # evaluation as a CI gate (exits 1 on regression)
```