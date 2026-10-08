import { requireAiProvider, type AiProvider } from "@/lib/ai-gateway.server";
import type { RetrievalClient } from "./client";
import { RETRIEVAL_CONFIG, type RetrievalConfig } from "./config";
import { buildContext, type BuiltContext } from "./context-builder";
import { denseRetrieve } from "./dense";
import { evaluateEvidence, type GateVerdict } from "./evidence-gate";
import { fuseCandidates } from "./fusion";
import { lexicalRetrieve } from "./lexical";
import { createLlmReranker, heuristicReranker, type Reranker } from "./reranker";
import { expandQuery } from "./query-rewrite";
import type { Candidate, RankedCandidate, RetrievalTelemetry } from "./types";

export type RetrievalOutcome = {
  context: BuiltContext;
  verdict: GateVerdict;
  ranked: RankedCandidate[];
  telemetry: Omit<RetrievalTelemetry, "requestId" | "grounded" | "gateReason">;
};

export type RetrievalDeps = {
  dense: (queries: string[]) => Promise<{
    candidates: Candidate[];
    embeddingLatencyMs: number;
    queryLatencyMs: number;
  }>;
  lexical: (queries: string[]) => Promise<{ candidates: Candidate[]; queryLatencyMs: number }>;
  expand: (question: string) => Promise<{ queries: string[]; rewritten: boolean }>;
  reranker: Reranker;
  /**
   * Caller-owned cancellation (e.g. the HTTP request's signal). Forwarded to
   * the reranker so a stalled provider call aborts when the caller goes away.
   */
  signal?: AbortSignal | undefined;
  config?: RetrievalConfig;
};

/**
 * question -> (expansion) -> dense + lexical -> fusion -> rerank -> evidence
 * gate -> context budget. Pure orchestration over injected retrievers so the
 * whole flow can be exercised in tests without a database or a model.
 *
 * Cancellation contract: an AbortError from the caller (e.g. the request's
 * signal fired during rerank) is never caught, swallowed, or converted into a
 * fallback/refusal here — it propagates out of `runRetrieval` untouched so
 * the route can terminate the request. Use `isCancellationError` to tell it
 * apart from provider errors.
 */
export async function runRetrieval(
  question: string,
  deps: RetrievalDeps,
): Promise<RetrievalOutcome> {
  const config = deps.config ?? RETRIEVAL_CONFIG;
  const started = Date.now();

  const { queries, rewritten } = await deps.expand(question);
  const [dense, lexical] = await Promise.all([deps.dense(queries), deps.lexical(queries)]);

  const fused = fuseCandidates({
    dense: dense.candidates,
    lexical: lexical.candidates,
    k: config.rrfK,
    denseWeight: config.denseWeight,
    lexicalWeight: config.lexicalWeight,
    limit: config.rerankCandidates,
  });

  const rerankStart = Date.now();
  const rerankResult = await deps.reranker.rerank(
    question,
    fused,
    config.rerankCandidates,
    deps.signal ? { signal: deps.signal } : undefined,
  );
  const ranked = rerankResult.ranked;
  const rerankLatencyMs = Date.now() - rerankStart;

  const verdict = evaluateEvidence(ranked, config.gate);
  const context = verdict.grounded
    ? buildContext(ranked, {
        maxSources: config.finalEvidence,
        maxTokens: config.maxContextTokens,
        maxSnippetChars: config.maxSnippetChars,
        duplicateThreshold: config.duplicateThreshold,
        maxPerPage: config.maxPerPage,
      })
    : { sources: [], contextBlock: "", contextTokens: 0, droppedDuplicates: 0 };

  return {
    context,
    verdict,
    ranked,
    telemetry: {
      queryRewritten: rewritten,
      queryVariants: queries.length,
      embeddingLatencyMs: dense.embeddingLatencyMs,
      denseLatencyMs: dense.queryLatencyMs,
      lexicalLatencyMs: lexical.queryLatencyMs,
      rerankLatencyMs,
      retrievalLatencyMs: Date.now() - started,
      denseCandidates: dense.candidates.length,
      lexicalCandidates: lexical.candidates.length,
      fusedCandidates: fused.length,
      rerankedCandidates: ranked.length,
      finalEvidence: context.sources.length,
      bestSimilarity: verdict.bestSimilarity,
      bestRerankScore: verdict.bestRerankScore,
      // The recorded name is whichever reranker actually produced the scores —
      // after a fallback that is the heuristic reranker, not the configured one.
      rerankerName: rerankResult.fallback?.rerankerName ?? deps.reranker.name,
      // "timeout" vs "provider-error", or null when the configured reranker
      // succeeded. Cancellation is never reported here: a caller abort throws
      // an AbortError out of the reranker instead of producing a fallback.
      // The chat route's telemetry attributes and trace read this field; the
      // reason travels here, never prompt or evidence content.
      rerankerFallback: rerankResult.fallback?.kind ?? null,
      contextTokens: context.contextTokens,
      droppedDuplicates: context.droppedDuplicates,
    },
  };
}

/** Wires the live Supabase-backed retrievers and the configured reranker. */
export function createLiveDeps(options: {
  client: RetrievalClient;
  userId: string;
  documentIds: string[] | null;
  provider?: AiProvider;
  /** Caller-owned cancellation forwarded to the reranker (e.g. request.signal). */
  signal?: AbortSignal | undefined;
  config?: RetrievalConfig;
}): RetrievalDeps {
  const config = options.config ?? RETRIEVAL_CONFIG;
  const provider = options.provider ?? requireAiProvider();

  return {
    config,
    expand: (question) => expandQuery({ question, provider, strategy: config.queryRewrite }),
    dense: (queries) =>
      denseRetrieve({
        client: options.client,
        queries,
        userId: options.userId,
        documentIds: options.documentIds,
        limit: config.denseCandidates,
        minSimilarity: config.minSimilarity,
        provider,
      }),
    lexical: (queries) =>
      lexicalRetrieve({
        client: options.client,
        queries,
        userId: options.userId,
        documentIds: options.documentIds,
        limit: config.lexicalCandidates,
      }),
    reranker:
      config.reranker === "llm"
        ? // The declared llmRerankerTimeoutMs bounds the real provider call.
          createLlmReranker(provider, undefined, { timeoutMs: config.llmRerankerTimeoutMs })
        : heuristicReranker,
    // Caller-owned cancellation forwarded to the reranker (e.g. request.signal).
    ...(options.signal ? { signal: options.signal } : {}),
  };
}
