/**
 * Tuning knobs for the hybrid retrieval pipeline. Everything the pipeline
 * decides on lives here so behaviour can be changed without touching logic.
 */

export type QueryRewriteStrategy = "off" | "auto" | "always";
export type RerankerStrategy = "heuristic" | "llm";

export const RETRIEVAL_CONFIG = {
  /** Candidate pool: intentionally much larger than the final evidence set. */
  denseCandidates: 20,
  lexicalCandidates: 20,
  /** Chunks kept after fusion and handed to the reranker. */
  rerankCandidates: 12,
  /** Final evidence passages sent to the model. */
  finalEvidence: 6,

  /** Dense floor applied inside the SQL function; candidates below never surface. */
  minSimilarity: 0.25,

  /** Reciprocal rank fusion constant. Larger = flatter weighting of top ranks. */
  rrfK: 60,
  /** Relative weights of each retriever inside fusion. */
  denseWeight: 1,
  lexicalWeight: 0.8,

  /** Query expansion: "auto" only expands short/vague questions. */
  queryRewrite: "auto" as QueryRewriteStrategy,
  maxQueryVariants: 3,
  /** A question with more content words than this is treated as specific enough. */
  rewriteWordThreshold: 6,
  /** Phase 4: caps the query rewrite prompt to avoid excessively long rewrites. */
  maxCharsPerQuery: 1000,

  reranker: "llm" as RerankerStrategy,
  /** Phase 4: degrade to heuristic reranking if the LLM does not respond in time. */
  llmRerankerTimeoutMs: 5000,

  /**
   * Bounded buffered answer generation (the /api/chat answer call). The
   * answer is generated COMPLETELY server-side before citation validation,
   * so an unbounded call could stall the request for minutes — both knobs
   * below keep it predictable.
   */
  generation: {
    /**
     * Hard cap on answer length, in tokens.
     *
     * Basis: the evidence context budget is 3200 tokens and the system prompt
     * requires CONCISE, structured answers (markdown lists, every claim
     * cited) over at most `finalEvidence` (6) passages — a typical cited
     * answer is a few hundred tokens. 1024 tokens (~4k chars / ~750 words) is
     * several times that, so legitimate answers never truncate, while
     * runaway or looping outputs are cut off instead of stalling the
     * buffered call. A bounded output is also what makes the deadline below
     * meaningful: worst-case generation work is capped.
     */
    maxOutputTokens: 1024,
    /**
     * Wall-clock deadline for the whole `generateText` call, in milliseconds.
     *
     * Basis: even at a pessimistic 20 tokens/s the full 1024-token cap
     * completes in ~51s, so 60s bounds provider queueing stalls and hung
     * connections without cutting healthy generations short. Combined with
     * the caller's signal through `linkAbort`, so a gone client aborts the
     * provider call immediately instead of waiting out the deadline.
     * Classification on expiry: caller abort wins (silent 499 termination);
     * a pure deadline expiry is a provider-side failure (AI_UNAVAILABLE 503).
     */
    timeoutMs: 60_000,
  },

  /** Evidence gate thresholds. All must pass for grounded = true. */
  gate: {
    minTopRerankScore: 0.35,
    minTopSimilarity: 0.3,
    minSupportingChunks: 1,
    /** A single weak chunk is not enough; two chunks may be, if each clears this. */
    supportingScore: 0.3,
  },

  /** Context budget, in estimated tokens (~4 chars per token). */
  maxContextTokens: 3200,
  maxSnippetChars: 1800,
  /** Jaccard similarity above which two passages count as near-duplicates. */
  duplicateThreshold: 0.82,
  /** At most this many passages from the same document page. */
  maxPerPage: 2,
} as const;

export type RetrievalConfig = typeof RETRIEVAL_CONFIG;
