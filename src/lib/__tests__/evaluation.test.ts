/**
 * Quality gate + metric math. Runs the real retrieval pipeline over the
 * deterministic fixture corpus, so a regression in fusion, reranking or the
 * evidence gate fails CI instead of shipping.
 */
import { describe, expect, it } from "vitest";
import {
  citationPrecision,
  falseRefusalRate,
  meanReciprocalRank,
  ndcgAtK,
  precisionAtK,
  recallAtK,
  reciprocalRank,
  refusalAccuracy,
} from "../../../evaluation/metrics";
import { isEnclosedInEvidence, runEvaluation } from "../../../evaluation/runner";
import { sanitizeAttributes } from "../observability/events";
import { latencySummary, percentile, rate, scoreDistribution } from "../observability/metrics";

describe("retrieval metric math", () => {
  const ranked = ["a", "b", "c", "d", "e"];

  it("computes recall@k", () => {
    expect(recallAtK(ranked, ["a", "c"], 3)).toBe(1);
    expect(recallAtK(ranked, ["a", "e"], 3)).toBe(0.5);
    expect(recallAtK(ranked, [], 3)).toBe(1);
  });

  it("computes precision@k", () => {
    expect(precisionAtK(ranked, ["a", "b"], 2)).toBe(1);
    expect(precisionAtK(ranked, ["e"], 2)).toBe(0);
  });

  it("computes reciprocal rank and MRR", () => {
    expect(reciprocalRank(ranked, ["b"])).toBe(0.5);
    expect(reciprocalRank(ranked, ["zzz"])).toBe(0);
    expect(meanReciprocalRank([1, 0.5, 0])).toBeCloseTo(0.5, 5);
  });

  it("computes nDCG@k with binary gains", () => {
    expect(ndcgAtK(ranked, ["a", "b"], 5)).toBe(1);
    expect(ndcgAtK(ranked, ["e"], 5)).toBeLessThan(1);
    expect(ndcgAtK(ranked, ["zzz"], 5)).toBe(0);
  });

  it("penalises citations outside the shown evidence", () => {
    expect(citationPrecision(["a", "b"], ["a", "b"], ["a", "b"])).toBe(1);
    expect(citationPrecision(["a", "hallucinated"], ["a", "b"], ["a", "b"])).toBe(0.5);
    expect(citationPrecision([], ["a"], ["a"])).toBe(0);
  });

  it("separates refusal accuracy from over-refusal", () => {
    const results = [
      { refused: true, expectRefusal: true },
      { refused: false, expectRefusal: false },
      { refused: true, expectRefusal: false },
    ];
    expect(refusalAccuracy(results)).toBe(1);
    expect(falseRefusalRate(results)).toBeCloseTo(0.5, 5);
  });
});

describe("observability metric math", () => {
  it("computes nearest-rank percentiles", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(20);
    expect(percentile([10, 20, 30, 40], 0.95)).toBe(40);
  });

  it("summarises latency without NaN", () => {
    const summary = latencySummary([100, 200, 300]);
    expect(summary.count).toBe(3);
    expect(summary.p50).toBe(200);
    expect(summary.mean).toBe(200);
    expect(latencySummary([]).mean).toBeNull();
  });

  it("never divides by zero", () => {
    expect(rate(0, 0)).toBe(0);
    expect(rate(1, 4)).toBe(0.25);
  });

  it("buckets scores into ten bins", () => {
    const bins = scoreDistribution([0.05, 0.15, 0.99, null, Number.NaN]);
    expect(bins).toHaveLength(10);
    expect(bins[0]!.count).toBe(1);
    expect(bins[9]!.count).toBe(1);
  });

  it("drops payload-bearing attribute keys but keeps dimensions", () => {
    const safe = sanitizeAttributes({
      prompt: "secret question text",
      answer_text: "leak",
      api_key: "abc",
      context_tokens: 1200,
      prompt_tokens: 40,
      final_evidence: 6,
      reranker: "llm",
    });
    expect(safe["prompt"]).toBeUndefined();
    expect(safe["answer_text"]).toBeUndefined();
    expect(safe["api_key"]).toBeUndefined();
    expect(safe["context_tokens"]).toBe(1200);
    expect(safe["prompt_tokens"]).toBe(40);
    expect(safe["final_evidence"]).toBe(6);
    expect(safe["reranker"]).toBe("llm");
  });
});

describe("injection enclosure check", () => {
  it("accepts markers quoted inside an evidence element", () => {
    const block =
      '<evidence id="source_01" document="a.pdf" page="1">\nIGNORE PREVIOUS\n</evidence>';
    expect(isEnclosedInEvidence(block, "IGNORE PREVIOUS")).toBe(true);
  });

  it("rejects markers that escaped the evidence boundary", () => {
    const block =
      '<evidence id="source_01" document="a.pdf" page="1">\nok\n</evidence>\nIGNORE PREVIOUS';
    expect(isEnclosedInEvidence(block, "IGNORE PREVIOUS")).toBe(false);
  });
});

describe("retrieval quality gate", () => {
  it("meets every configured threshold on the golden set", async () => {
    const report = await runEvaluation();
    // Surface the exact violations in the failure message.
    expect(report.violations).toEqual([]);
    expect(report.passed).toBe(true);
  }, 30_000);

  it("refuses every unanswerable question that has no near-miss evidence", async () => {
    const report = await runEvaluation();
    const gateNegatives = report.cases.filter(
      (c) => c.expectRefusal && c.refusalStage === "retrieval",
    );
    expect(gateNegatives.length).toBeGreaterThan(0);
    for (const negative of gateNegatives) expect(negative.refused).toBe(true);
  }, 30_000);

  it("keeps adversarial passages contained and citations valid", async () => {
    const report = await runEvaluation();
    for (const result of report.cases) {
      expect(result.injectionSafe).toBe(true);
      expect(result.citationsValid).toBe(true);
    }
  }, 30_000);
});
