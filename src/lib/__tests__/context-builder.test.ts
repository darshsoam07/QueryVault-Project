import { describe, expect, it } from "vitest";
import { RETRIEVAL_CONFIG } from "../retrieval/config";
import {
  buildContext,
  compressAdjoiningPassages,
  computeDynamicJaccardThreshold,
  estimateTokens,
  extractSectionBreadcrumb,
  findTextOverlap,
  formatSourceId,
  jaccard,
} from "../retrieval/context-builder";
import type { RankedCandidate } from "../retrieval/types";

describe("context-builder helper functions", () => {
  it("extracts section breadcrumbs when present", () => {
    const withHeader =
      "[Section: 1.0 Agreement > 1.2 Terms]\n\nThe parties agree to the terms herein.";
    const parsed = extractSectionBreadcrumb(withHeader);
    expect(parsed.section).toBe("1.0 Agreement > 1.2 Terms");
    expect(parsed.body).toBe("The parties agree to the terms herein.");

    const withoutHeader = "Standard clause without any markdown heading breadcrumb.";
    const plain = extractSectionBreadcrumb(withoutHeader);
    expect(plain.section).toBeNull();
    expect(plain.body).toBe(withoutHeader);
  });

  it("finds longest suffix-prefix text overlap", () => {
    const a = "The quick brown fox jumps over the lazy dog. The cat slept peacefully.";
    const b = "The cat slept peacefully. Meanwhile the rooster crowed at dawn.";

    const overlapLen = findTextOverlap(a, b, 16);
    expect(overlapLen).toBe("The cat slept peacefully.".length);

    // Below minimum overlap threshold
    const shortA = "Sentence A. Ok.";
    const shortB = "Ok. Sentence B.";
    expect(findTextOverlap(shortA, shortB, 16)).toBe(0);

    // No overlap
    expect(findTextOverlap("First independent topic.", "Second independent topic.", 16)).toBe(0);
  });

  it("compresses adjoining passages removing duplicate overlap and merging section headers", () => {
    const chunk1 =
      "[Section: Compliance]\n\nAll employees must complete compliance training annually. Violations result in disciplinary action.";
    const chunk2 =
      "[Section: Compliance]\n\nViolations result in disciplinary action. Escalations are reviewed by the legal department.";

    const merged = compressAdjoiningPassages(chunk1, chunk2, 16);
    expect(merged).toContain("[Section: Compliance]\n\n");
    // Section breadcrumb appears only once
    expect(merged.split("[Section: Compliance]").length - 1).toBe(1);
    // Overlapping sentence appears only once
    expect(merged.split("Violations result in disciplinary action.").length - 1).toBe(1);
    expect(merged).toBe(
      "[Section: Compliance]\n\nAll employees must complete compliance training annually. Violations result in disciplinary action. Escalations are reviewed by the legal department.",
    );
  });

  it("handles transitioning section breadcrumbs across adjoining passages", () => {
    const chunk1 = "[Section: Section A]\n\nConcluding remarks of Section A.";
    const chunk2 = "[Section: Section B]\n\nCommencing remarks of Section B.";

    const merged = compressAdjoiningPassages(chunk1, chunk2, 16);
    expect(merged).toContain("[Section: Section A → Section B]\n\n");
    expect(merged).toContain("Concluding remarks of Section A.");
    expect(merged).toContain("Commencing remarks of Section B.");
  });

  it("computes score-aware dynamic Jaccard thresholds", () => {
    const base = 0.82;

    // High scoring candidate raises bar (avoids false duplicate drops)
    const highScore = computeDynamicJaccardThreshold(0.95, base);
    expect(highScore).toBeGreaterThan(base);
    expect(highScore).toBeCloseTo(0.884, 2);

    // Maximum cap at 0.92
    const maxScore = computeDynamicJaccardThreshold(1.0, base);
    expect(maxScore).toBeLessThanOrEqual(0.92);

    // Low scoring candidate lowers bar (sheds redundant boilerplate aggressively)
    const lowScore = computeDynamicJaccardThreshold(0.3, base);
    expect(lowScore).toBeLessThan(base);
    expect(lowScore).toBeCloseTo(0.78, 2);

    // Mid score hovers around base
    const midScore = computeDynamicJaccardThreshold(0.625, base);
    expect(midScore).toBeCloseTo(base, 2);

    // Fallback for null/undefined/NaN
    expect(computeDynamicJaccardThreshold(null, base)).toBe(base);
    expect(computeDynamicJaccardThreshold(undefined, base)).toBe(base);
    expect(computeDynamicJaccardThreshold(Number.NaN, base)).toBe(base);
  });
});

describe("buildContext with Phase 3 Token Packing", () => {
  const makeCandidate = (
    id: string,
    content: string,
    chunkIndex = 0,
    page = 1,
    documentId = "doc-1",
    rerankScore = 0.9,
  ): RankedCandidate => ({
    chunkId: id,
    documentId,
    filename: "contract.pdf",
    page,
    chunkIndex,
    content,
    similarity: 0.7,
    lexicalRank: 0.5,
    densePosition: 1,
    lexicalPosition: 1,
    fusionScore: 0.8,
    rerankScore,
    rerankerName: "heuristic",
  });

  it("merges adjoining chunks from the same document in natural order", () => {
    const chunk0 = makeCandidate(
      "c0",
      "[Section: Scope]\n\nThe supplier shall deliver weekly updates. All reports must include status metrics.",
      0,
      1,
      "doc-1",
      0.95,
    );
    const chunk1 = makeCandidate(
      "c1",
      "[Section: Scope]\n\nAll reports must include status metrics. Failure to submit on time triggers a 5% credit.",
      1,
      1,
      "doc-1",
      0.85,
    );

    const result = buildContext([chunk0, chunk1]);

    // Should be compressed into 1 evidence source instead of 2
    expect(result.sources).toHaveLength(1);
    expect(result.mergedPassages).toBe(1);
    expect(result.sources[0]?.sourceId).toBe("source_01");
    expect(result.sources[0]?.chunkId).toBe("c0");

    // Overlap deduplicated in snippet
    const snippet = result.sources[0]?.snippet ?? "";
    expect(snippet).toContain("[Section: Scope]\n\n");
    expect(snippet.split("All reports must include status metrics.").length - 1).toBe(1);
    expect(snippet).toContain("Failure to submit on time triggers a 5% credit.");
  });

  it("merges adjoining chunks even when retrieved out of order (later chunk ranked higher)", () => {
    // chunk 1 retrieved first (higher score), chunk 0 retrieved second
    const chunk1 = makeCandidate(
      "c1",
      "[Section: Billing]\n\nInvoices are payable within 30 days. Late balances accrue 1.5% monthly interest.",
      1,
      2,
      "doc-1",
      0.96,
    );
    const chunk0 = makeCandidate(
      "c0",
      "[Section: Billing]\n\nFees are billed monthly in advance. Invoices are payable within 30 days.",
      0,
      2,
      "doc-1",
      0.88,
    );

    const result = buildContext([chunk1, chunk0]);

    expect(result.sources).toHaveLength(1);
    expect(result.mergedPassages).toBe(1);

    // Reading order is preserved: chunk 0 text appears before chunk 1 text
    const snippet = result.sources[0]?.snippet ?? "";
    expect(snippet.indexOf("Fees are billed monthly in advance.")).toBeLessThan(
      snippet.indexOf("Late balances accrue 1.5% monthly interest."),
    );
    expect(snippet.split("Invoices are payable within 30 days.").length - 1).toBe(1);
  });

  it("does not merge non-adjoining chunks from the same document", () => {
    const chunk0 = makeCandidate(
      "c0",
      "Preamble text about party identities and recitals.",
      0,
      1,
      "doc-1",
    );
    const chunk5 = makeCandidate(
      "c5",
      "Arbitration clause governing disputes in Delaware courts.",
      5,
      1,
      "doc-1",
    );

    const result = buildContext([chunk0, chunk5]);

    expect(result.sources).toHaveLength(2);
    expect(result.mergedPassages).toBe(0);
    expect(result.sources[0]?.sourceId).toBe("source_01");
    expect(result.sources[1]?.sourceId).toBe("source_02");
  });

  it("does not merge chunks from different documents even if chunkIndex is adjacent", () => {
    const docA = makeCandidate("c0", "Content from Document A.", 0, 1, "doc-A");
    const docB = makeCandidate("c1", "Content from Document B.", 1, 1, "doc-B");

    const result = buildContext([docA, docB]);
    expect(result.sources).toHaveLength(2);
    expect(result.mergedPassages).toBe(0);
  });

  it("preserves high-scoring candidates with distinct claims under dynamic Jaccard folding", () => {
    const textA =
      "The vendor guarantees 99.9% uptime per calendar quarter for production databases.";
    const textB =
      "The vendor guarantees 99.9% uptime per calendar quarter for non-production staging environments.";

    // Candidates have high lexical similarity due to boilerplate phrasing, but both have high rerank scores
    const candA = makeCandidate("a", textA, 0, 1, "doc-1", 0.95);
    const candB = makeCandidate("b", textB, 10, 2, "doc-1", 0.92);

    const result = buildContext([candA, candB], { dynamicJaccard: true });
    // Dynamic Jaccard raised the threshold for 0.92, preserving both distinct claims
    expect(result.sources).toHaveLength(2);
    expect(result.droppedDuplicates).toBe(0);
  });

  it("sheds redundant low-scoring candidates under dynamic Jaccard folding", () => {
    const textA =
      "Service credits are calculated as ten percent of monthly subscription fees for SLA breaches. " +
      "The customer must submit a written claim within thirty days of the incident with system logs. " +
      "All approved credits will be applied directly to the subsequent calendar month invoice.";
    const textB =
      "Service credits are calculated as ten percent of monthly subscription fees for SLA breaches. " +
      "The customer must submit a written claim within thirty days of the incident with detailed system logs. " +
      "All approved credits will be applied directly to the following calendar month invoice.";

    // First candidate has strong rerank score; second is weak near-duplicate paraphrase
    const candA = makeCandidate("a", textA, 0, 1, "doc-1", 0.9);
    const candB = makeCandidate("b", textB, 10, 2, "doc-1", 0.3);

    const result = buildContext([candA, candB], { dynamicJaccard: true });
    // Dynamic Jaccard lowered the threshold for 0.30, dropping the redundant paraphrase
    expect(result.sources).toHaveLength(1);
    expect(result.droppedDuplicates).toBe(1);
  });

  it("strictly respects the maxTokens budget and clamps safely", () => {
    const longChunk = "clause ".repeat(1000);
    const cand1 = makeCandidate("c1", longChunk, 0, 1, "doc-1");
    const cand2 = makeCandidate("c2", "second short chunk", 5, 2, "doc-1");

    const result = buildContext([cand1, cand2], { maxTokens: 200 });
    expect(result.contextTokens).toBeLessThanOrEqual(250);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.sourceId).toBe(formatSourceId(0));
  });

  it("honors maxSources and maxPerPage constraints", () => {
    const candidates = [
      makeCandidate("c1", "Unique topic 1 on page 1", 0, 1, "doc-1"),
      makeCandidate("c2", "Unique topic 2 on page 1", 5, 1, "doc-1"),
      makeCandidate("c3", "Unique topic 3 on page 1", 10, 1, "doc-1"), // should hit maxPerPage = 2
      makeCandidate("c4", "Unique topic 4 on page 2", 15, 2, "doc-1"),
    ];

    const result = buildContext(candidates, { maxPerPage: 2, maxSources: 3 });
    expect(result.sources).toHaveLength(3);
    // c3 was dropped due to maxPerPage
    expect(result.sources.map((s) => s.chunkId)).toEqual(["c1", "c2", "c4"]);
    expect(result.droppedDuplicates).toBe(1);
  });
});
