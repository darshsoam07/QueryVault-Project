import { RETRIEVAL_CONFIG } from "./config";
import type { RankedCandidate } from "./types";

export type GateVerdict = {
  grounded: boolean;
  /** Machine-readable reason, logged internally — never shown as "confidence". */
  reason: "ok" | "no_candidates" | "weak_top_score" | "insufficient_support" | "no_coverage";
  supportingChunks: number;
  distinctDocuments: number;
  bestSimilarity: number | null;
  bestRerankScore: number | null;
};

type GateOptions = typeof RETRIEVAL_CONFIG.gate & { requireTermCoverage?: boolean };

/**
 * Decides whether there is enough evidence to answer at all. Runs before the
 * model is called, so a weak retrieval turns into an honest refusal rather than
 * an invitation to hallucinate.
 */
export function evaluateEvidence(
  candidates: RankedCandidate[],
  gate: GateOptions = RETRIEVAL_CONFIG.gate,
): GateVerdict {
  if (candidates.length === 0) {
    return {
      grounded: false,
      reason: "no_candidates",
      supportingChunks: 0,
      distinctDocuments: 0,
      bestSimilarity: null,
      bestRerankScore: null,
    };
  }

  const similarities = candidates
    .map((candidate) => candidate.similarity)
    .filter((value): value is number => typeof value === "number");
  const rerankScores = candidates
    .map((candidate) => candidate.rerankScore)
    .filter((value): value is number => typeof value === "number");

  const bestSimilarity = similarities.length > 0 ? Math.max(...similarities) : null;
  const bestRerankScore = rerankScores.length > 0 ? Math.max(...rerankScores) : null;

  const supporting = candidates.filter((candidate) => {
    const rerank = candidate.rerankScore;
    if (typeof rerank === "number") return rerank >= gate.supportingScore;
    return (candidate.similarity ?? 0) >= gate.minTopSimilarity;
  });
  const distinctDocuments = new Set(supporting.map((candidate) => candidate.documentId)).size;

  const base = {
    supportingChunks: supporting.length,
    distinctDocuments,
    bestSimilarity,
    bestRerankScore,
  };

  const topRerankOk = bestRerankScore === null || bestRerankScore >= gate.minTopRerankScore;
  const topSimilarityOk = bestSimilarity === null || bestSimilarity >= gate.minTopSimilarity;
  if (!topRerankOk || !topSimilarityOk) {
    return { grounded: false, reason: "weak_top_score", ...base };
  }
  if (supporting.length < gate.minSupportingChunks) {
    return { grounded: false, reason: "insufficient_support", ...base };
  }

  return { grounded: true, reason: "ok", ...base };
}
