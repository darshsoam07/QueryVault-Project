import type { Candidate, FusedCandidate } from "./types";

/**
 * Reciprocal rank fusion. Rank-based rather than score-based, because cosine
 * similarity and ts_rank_cd are not on a comparable scale — mixing the raw
 * numbers would silently let one retriever dominate.
 */
export function fuseCandidates(options: {
  dense: Candidate[];
  lexical: Candidate[];
  k: number;
  denseWeight: number;
  lexicalWeight: number;
  limit: number;
}): FusedCandidate[] {
  const { dense, lexical, k, denseWeight, lexicalWeight, limit } = options;
  const merged = new Map<string, FusedCandidate>();

  const upsert = (candidate: Candidate, contribution: number) => {
    const existing = merged.get(candidate.chunkId);
    if (!existing) {
      merged.set(candidate.chunkId, { ...candidate, fusionScore: contribution });
      return;
    }
    existing.fusionScore += contribution;
    existing.similarity = existing.similarity ?? candidate.similarity;
    existing.lexicalRank = existing.lexicalRank ?? candidate.lexicalRank;
    existing.densePosition = existing.densePosition ?? candidate.densePosition;
    existing.lexicalPosition = existing.lexicalPosition ?? candidate.lexicalPosition;
  };

  dense.forEach((candidate, index) => {
    upsert(candidate, denseWeight / (k + (candidate.densePosition ?? index + 1)));
  });
  lexical.forEach((candidate, index) => {
    upsert(candidate, lexicalWeight / (k + (candidate.lexicalPosition ?? index + 1)));
  });

  return [...merged.values()]
    .sort((a, b) => {
      if (b.fusionScore !== a.fusionScore) return b.fusionScore - a.fusionScore;
      return (b.similarity ?? 0) - (a.similarity ?? 0);
    })
    .slice(0, limit);
}
