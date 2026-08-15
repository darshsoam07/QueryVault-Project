# Design decisions

Short write-ups of the non-obvious calls in this project — the kind of thing
worth being able to explain out loud, not just point to in the code.

## 1. Evidence gate before generation, not "prompt it to say I don't know"

The naive approach to reducing hallucination is a system-prompt instruction:
"if you don't know, say so." That's weak — it relies on the model noticing its
own uncertainty, and a model shown five semi-relevant passages will often
stitch together a plausible-sounding answer anyway.

Instead, `evidence-gate.ts` runs a hard check *before* the LLM is ever called:
best similarity, best rerank score, and supporting-chunk count all have
thresholds. If they aren't met, the system returns a fixed refusal string and
never makes a generation call.

Trade-off: this can produce false refusals when retrieval finds nothing
relevant even though a good answer might exist with better recall. The eval
harness measures this directly (`false_refusal_rate`) so the threshold is a
tuned number, not a guess.

## 2. Reciprocal Rank Fusion instead of blending raw scores

Dense retrieval returns cosine similarity (0–1, roughly comparable across
queries). Lexical retrieval returns `ts_rank_cd` (an unbounded, corpus- and
query-dependent number). Averaging or weighting these directly would let
whichever retriever happens to produce larger raw numbers dominate, for
reasons that have nothing to do with actual relevance.

RRF (`fusion.ts`) instead fuses by *rank position*: `1 / (k + rank)` per
retriever, summed. It only cares about where each retriever placed a
candidate relative to its own other results, not the scale of the score.
This is a well-known IR technique for exactly this reason — it's simple,
has one tuning constant (`k`), and doesn't require score calibration between
retrievers that will never naturally be on the same scale.

## 3. LLM reranker with a deterministic heuristic fallback

An LLM-based listwise reranker (`reranker.ts`) gives materially better
relevance ordering than a hand-written heuristic — but it's a network call to
an external model that can fail, time out, or return unparseable output.

Rather than letting a reranker failure take down retrieval, `createLlmReranker`
catches any failure (HTTP error, malformed JSON, unparseable scores) and falls
back to `heuristicReranker` — a dependency-free scorer blending query-term
coverage with dense similarity. It's a worse ranker, but it's *available*, and
retrieval degrading gracefully to "good enough" beats it going down entirely
because a third-party API had a bad minute.

This is also what makes the CI evaluation harness possible without a live API
key: `evaluation/runner.ts` exercises the real pipeline logic with the
heuristic reranker, so retrieval regressions are caught in CI without a
network dependency.

## 4. Deterministic chunk IDs instead of random UUIDs

Ingestion is a multi-step, failure-prone pipeline (download → parse → chunk →
embed → index) running as a retryable background job. If a job dies partway
through and retries, random-UUID chunks would either duplicate rows or need
a separate "delete everything and start over" step.

Instead, chunk ids are derived deterministically from
`(document_id, chunking_version, chunk_index)` via SHA-256
(`deterministicChunkId`). A retried batch re-computes the *same* ids and
upserts (`onConflict: "id"`), so retries are naturally idempotent. Bumping
`CHUNKER_VERSION` when chunking logic changes forces new ids for all chunks of
that document, and a pruning step removes chunks from stale versions once a
reprocess completes — so an in-progress reprocess doesn't leave old and new
chunk boundaries both retrievable indefinitely.

## 5. RLS *and* application-level user-id checks — deliberately redundant

Every table has Postgres Row-Level Security scoped to `auth.uid()`. That alone
would be sufficient. The retrieval SQL functions (`match_document_chunks`,
`lexical_document_chunks`) *also* take a `requesting_user_id` parameter and
independently assert `auth.uid() = requesting_user_id` inside the function
body, on top of RLS.

This looks redundant, and it's meant to be: it means a bug in application code
that passed the wrong user id, or a future refactor that accidentally called
these functions with a service-role client (bypassing RLS), would still be
caught by the function's own check. Defense in depth for the one thing this
app absolutely cannot get wrong — one tenant seeing another tenant's document
content.

## Known trade-offs / what I'd do differently at larger scale

- **No cost-based rate limiting.** The rate limiter caps *requests* (e.g. 30
  chat messages/min), not the actual number of downstream LLM calls a request
  can trigger (query rewrite + N dense embeddings + rerank + generation — up
  to ~4 model calls per question). At scale this needs a token- or cost-based
  budget, not just a request counter.
- **Fixed embedding dimensionality baked into the schema**
  (`halfvec(3072)`). Changing the embedding model later is a real migration
  (backfill + dual-write), not a config change.
- **Static evidence-gate thresholds.** They're tuned against a 13-case fixture
  set; a larger, more diverse document corpus would likely need the
  thresholds re-measured rather than assumed to generalize.