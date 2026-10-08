/** Shared types for the hybrid retrieval pipeline. */

/** A chunk returned by one of the retrievers, before fusion. */
export type Candidate = {
  chunkId: string;
  documentId: string;
  filename: string;
  page: number;
  chunkIndex: number;
  content: string;
  /** Cosine similarity from pgvector, when the chunk came from dense retrieval. */
  similarity: number | null;
  /** ts_rank_cd score, when the chunk came from lexical retrieval. */
  lexicalRank: number | null;
  /** 1-based position in the dense result list (null when not retrieved densely). */
  densePosition: number | null;
  /** 1-based position in the lexical result list (null when not retrieved lexically). */
  lexicalPosition: number | null;
};

/** A candidate after reciprocal-rank fusion. */
export type FusedCandidate = Candidate & { fusionScore: number };

/** A candidate after reranking. `rerankScore` is null when no reranker ran. */
export type RankedCandidate = FusedCandidate & {
  rerankScore: number | null;
  rerankerName: string;
};

/**
 * Why the configured reranker did not produce the final ranking.
 * - `timeout`: the LLM reranker exceeded `llmRerankerTimeoutMs` and the
 *   underlying provider request was aborted.
 * - `provider-error`: the provider call failed (network, status, unparsable).
 *
 * Caller cancellation is deliberately NOT a fallback kind: a caller abort is
 * a request termination event. The reranker throws the cancellation (an
 * AbortError) instead of falling back, and the chat route records it as the
 * separate safe `chat.request_cancelled` event. Telemetry's
 * `rerankerFallback` therefore never reports a cancellation.
 */
export type RerankFallbackKind = "timeout" | "provider-error";

/**
 * A passage handed to the model and the UI. `sourceId` is immutable and
 * request-scoped: the model may only cite these ids.
 */
export type EvidenceSource = {
  sourceId: string;
  chunkId: string;
  documentId: string;
  filename: string;
  page: number;
  similarityScore: number | null;
  rerankScore: number | null;
  snippet: string;
};

export type RetrievalTelemetry = {
  requestId: string;
  queryRewritten: boolean;
  queryVariants: number;
  embeddingLatencyMs: number;
  denseLatencyMs: number;
  lexicalLatencyMs: number;
  rerankLatencyMs: number;
  retrievalLatencyMs: number;
  denseCandidates: number;
  lexicalCandidates: number;
  fusedCandidates: number;
  rerankedCandidates: number;
  finalEvidence: number;
  bestSimilarity: number | null;
  bestRerankScore: number | null;
  /** Name of the reranker that ACTUALLY produced the final scores. After a
   * fallback this is the heuristic reranker, not the configured one. */
  rerankerName: string;
  /** Why a fallback reranker produced the scores, or null when the configured
   * reranker succeeded. Lets timeout fallbacks be told apart from
   * provider-error fallbacks in telemetry and traces. */
  rerankerFallback: RerankFallbackKind | null;
  contextTokens: number;
  droppedDuplicates: number;
  grounded: boolean;
  gateReason: string;
};
