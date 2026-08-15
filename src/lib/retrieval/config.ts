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

  reranker: "llm" as RerankerStrategy,

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
