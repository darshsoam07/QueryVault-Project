/**
 * Pure metric math shared by the operator dashboard, the health endpoint and
 * the evaluation runner. No I/O, so every number is unit-testable.
 */

/** Nearest-rank percentile (p in 0..1). Returns null for an empty sample. */
export function percentile(values: number[], p: number): number | null {
  const sample = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sample.length === 0) return null;
  const clamped = Math.min(Math.max(p, 0), 1);
  const rank = Math.ceil(clamped * sample.length);
  return sample[Math.max(0, rank - 1)] ?? null;
}

export type LatencySummary = {
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  mean: number | null;
};

export function latencySummary(values: number[]): LatencySummary {
  const sample = values.filter((value) => Number.isFinite(value));
  return {
    count: sample.length,
    p50: percentile(sample, 0.5),
    p95: percentile(sample, 0.95),
    p99: percentile(sample, 0.99),
    max: sample.length ? Math.max(...sample) : null,
    mean: sample.length ? sample.reduce((sum, v) => sum + v, 0) / sample.length : null,
  };
}

/** Safe ratio: 0 events means 0, never NaN or Infinity. */
export function rate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

export function pct(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

/** Buckets a score sample into fixed 0.1-wide bins for a distribution view. */
export function scoreDistribution(scores: Array<number | null | undefined>): Array<{
  bucket: string;
  from: number;
  count: number;
}> {
  const bins = Array.from({ length: 10 }, (_, i) => ({
    bucket: `${(i / 10).toFixed(1)}–${((i + 1) / 10).toFixed(1)}`,
    from: i / 10,
    count: 0,
  }));
  for (const score of scores) {
    if (typeof score !== "number" || !Number.isFinite(score)) continue;
    const clamped = Math.min(Math.max(score, 0), 0.9999);
    const index = Math.floor(clamped * 10);
    bins[index]!.count += 1;
  }
  return bins;
}
