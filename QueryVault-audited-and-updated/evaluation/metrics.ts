/**
 * Retrieval-quality metrics. Pure functions over ranked id lists so they can be
 * unit-tested and reused by the CI gate and any offline analysis.
 */

/** Fraction of relevant items that appear in the top-k ranking. */
export function recallAtK(ranked: string[], relevant: string[], k: number): number {
  if (relevant.length === 0) return 1;
  const top = new Set(ranked.slice(0, k));
  const hits = relevant.filter((id) => top.has(id)).length;
  return hits / relevant.length;
}

/** Fraction of the top-k ranking that is relevant. */
export function precisionAtK(ranked: string[], relevant: string[], k: number): number {
  const top = ranked.slice(0, k);
  if (top.length === 0) return relevant.length === 0 ? 1 : 0;
  const wanted = new Set(relevant);
  return top.filter((id) => wanted.has(id)).length / top.length;
}

/** Reciprocal rank of the first relevant hit; 0 when none is retrieved. */
export function reciprocalRank(ranked: string[], relevant: string[]): number {
  const wanted = new Set(relevant);
  const index = ranked.findIndex((id) => wanted.has(id));
  return index === -1 ? 0 : 1 / (index + 1);
}

export function meanReciprocalRank(rrs: number[]): number {
  if (rrs.length === 0) return 0;
  return rrs.reduce((sum, value) => sum + value, 0) / rrs.length;
}

/** Binary-gain nDCG@k with an ideal ranking of all relevant items first. */
export function ndcgAtK(ranked: string[], relevant: string[], k: number): number {
  if (relevant.length === 0) return 1;
  const wanted = new Set(relevant);
  const dcg = ranked
    .slice(0, k)
    .reduce((sum, id, i) => sum + (wanted.has(id) ? 1 / Math.log2(i + 2) : 0), 0);
  const ideal = Array.from({ length: Math.min(relevant.length, k) }).reduce<number>(
    (sum, _v, i) => sum + 1 / Math.log2(i + 2),
    0,
  );
  return ideal === 0 ? 1 : dcg / ideal;
}

/**
 * Citation precision: of the ids the model cited, how many were actually part
 * of the evidence it was shown AND relevant to the question. Hallucinated or
 * decorative citations drag this down.
 */
export function citationPrecision(
  cited: string[],
  evidenceIds: string[],
  relevant: string[],
): number {
  if (cited.length === 0) return 0;
  const shown = new Set(evidenceIds);
  const wanted = new Set(relevant);
  const good = cited.filter((id) => shown.has(id) && (wanted.size === 0 || wanted.has(id)));
  return good.length / cited.length;
}

/** Share of answers the system grounded (answered) when it should have. */
export function answerRate(results: Array<{ refused: boolean; expectRefusal: boolean }>): number {
  const answerable = results.filter((r) => !r.expectRefusal);
  if (answerable.length === 0) return 1;
  return answerable.filter((r) => !r.refused).length / answerable.length;
}

/** Share of unanswerable questions the system correctly refused. */
export function refusalAccuracy(
  results: Array<{ refused: boolean; expectRefusal: boolean }>,
): number {
  const negatives = results.filter((r) => r.expectRefusal);
  if (negatives.length === 0) return 1;
  return negatives.filter((r) => r.refused).length / negatives.length;
}

/** Share of answerable questions wrongly refused — the "over-refusal" failure. */
export function falseRefusalRate(
  results: Array<{ refused: boolean; expectRefusal: boolean }>,
): number {
  return 1 - answerRate(results);
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
