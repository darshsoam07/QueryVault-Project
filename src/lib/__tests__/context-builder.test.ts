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
  describe("findTextOverlap", () => {
    it("detects exact and identical suffix-prefix text overlaps", () => {
      const a = "The quick brown fox jumps over the lazy dog. The cat slept peacefully.";
      const b = "The cat slept peacefully. Meanwhile the rooster crowed at dawn.";

      const overlapLen = findTextOverlap(a, b, 16);
      expect(overlapLen).toBe("The cat slept peacefully.".length);
    });

    it("handles whitespace tolerance across newlines and spaces", () => {
      const a = "Section concludes with summary.\n\nAll actions require sign-off.";
      const b = "All actions require sign-off.   Next section commences.";

      const overlapLen = findTextOverlap(a, b, 16);
      expect(overlapLen).toBeGreaterThanOrEqual("All actions require sign-off.".length);
    });

    it("returns 0 for disjoint text or overlaps below minChars", () => {
      // Disjoint text
      expect(findTextOverlap("First independent topic.", "Second independent topic.", 16)).toBe(0);

      // Overlap shorter than minChars (16)
      const shortA = "Sentence A. Ok.";
      const shortB = "Ok. Sentence B.";
      expect(findTextOverlap(shortA, shortB, 16)).toBe(0);
    });
  });

  describe("extractSectionBreadcrumb", () => {
    it("extracts breadcrumb and cleanText when markdown section header is present", () => {
      const text = "[Section: 1.0 Agreement > 1.2 Terms]\n\nThe parties agree to the terms herein.";
      const result = extractSectionBreadcrumb(text);
      expect(result.breadcrumb).toBe("1.0 Agreement > 1.2 Terms");
      expect(result.cleanText).toBe("The parties agree to the terms herein.");
      // Backwards compatibility alias checks
      expect(result.section).toBe("1.0 Agreement > 1.2 Terms");
      expect(result.body).toBe("The parties agree to the terms herein.");
    });

    it("returns null breadcrumb and untouched cleanText when header is absent", () => {
      const plain = "Standard clause without any markdown heading breadcrumb.";
      const result = extractSectionBreadcrumb(plain);
      expect(result.breadcrumb).toBeNull();
      expect(result.cleanText).toBe(plain);
      expect(result.section).toBeNull();
      expect(result.body).toBe(plain);
    });
  });

  describe("compressAdjoiningPassages", () => {
    it("compresses adjoining passages removing duplicate overlap and deduplicating section headers", () => {
      const chunk1 =
        "[Section: Compliance]\n\nAll employees must complete compliance training annually. Violations result in disciplinary action.";
      const chunk2 =
        "[Section: Compliance]\n\nViolations result in disciplinary action. Escalations are reviewed by the legal department.";

      const merged = compressAdjoiningPassages(chunk1, chunk2, 16);
      expect(merged).toContain("[Section: Compliance]\n\n");
      // Header appears only once
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
  });

  describe("computeDynamicJaccardThreshold", () => {
    it("scales up to 0.92 for score >= 0.75", () => {
      const base = 0.82;

      // Score 0.75: base threshold
      expect(computeDynamicJaccardThreshold(0.75, base)).toBeCloseTo(0.82, 2);

      // Score 0.95: scaled up to protect high-scoring distinct claims
      const highScore = computeDynamicJaccardThreshold(0.95, base);
      expect(highScore).toBeGreaterThan(base);
      expect(highScore).toBeCloseTo(0.9, 2);

      // Score 1.0: capped at 0.92
      const maxScore = computeDynamicJaccardThreshold(1.0, base);
      expect(maxScore).toBeCloseTo(0.92, 2);
    });

    it("scales down to 0.70 for score < 0.50", () => {
      const base = 0.82;

      // Score 0.50: base threshold
      expect(computeDynamicJaccardThreshold(0.5, base)).toBeCloseTo(0.82, 2);

      // Score 0.25: scaled down halfway between base (0.82) and 0.70 -> 0.76
      const lowScore = computeDynamicJaccardThreshold(0.25, base);
      expect(lowScore).toBeLessThan(base);
      expect(lowScore).toBeCloseTo(0.76, 2);

      // Score 0.0: floored at 0.70
      const minScore = computeDynamicJaccardThreshold(0.0, base);
      expect(minScore).toBeCloseTo(0.7, 2);
    });

    it("safely handles null, undefined, and NaN scores with baseThreshold", () => {
      const base = 0.82;
      expect(computeDynamicJaccardThreshold(null, base)).toBe(base);
      expect(computeDynamicJaccardThreshold(undefined, base)).toBe(base);
      expect(computeDynamicJaccardThreshold(Number.NaN, base)).toBe(base);
    });
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

  it("merges adjoining chunks from the same document in natural order and preserves schema invariants", () => {
    const chunk0 = makeCandidate(
      "c0",
      "[Section: Scope]\n\nThe supplier shall deliver weekly updates. All reports must include status metrics.",
      0,
      1,
      "doc-1",
      0.85,
    );
    const chunk1 = makeCandidate(
      "c1",
      "[Section: Scope]\n\nAll reports must include status metrics. Failure to submit on time triggers a 5% credit.",
      1,
      1,
      "doc-1",
      0.95,
    );

    const result = buildContext([chunk0, chunk1]);

    // Should be compressed into 1 evidence source instead of 2
    expect(result.sources).toHaveLength(1);
    expect(result.mergedPassages).toBe(1);
    expect(result.sources[0]?.sourceId).toBe("source_01");
    expect(result.sources[0]?.chunkId).toBe("c0");

    // EvidenceSource.page remains a number
    expect(typeof result.sources[0]?.page).toBe("number");
    expect(result.sources[0]?.page).toBe(1);

    // rerankScore takes the maximum of the merged pair (max(0.85, 0.95) = 0.95)
    expect(result.sources[0]?.rerankScore).toBe(0.95);

    // Overlap deduplicated in snippet
    const snippet = result.sources[0]?.snippet ?? "";
    expect(snippet).toContain("[Section: Scope]\n\n");
    expect(snippet.split("All reports must include status metrics.").length - 1).toBe(1);
    expect(snippet).toContain("Failure to submit on time triggers a 5% credit.");

    // Formatted XML contextBlock has canonical tag
    expect(result.contextBlock).toContain(
      '<evidence id="source_01" document="contract.pdf" page="1">',
    );
    expect(result.contextBlock).toContain("</evidence>");
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

    // Both candidates have high rerank scores and shared boilerplate
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
    const candB = makeCandidate("b", textB, 10, 2, "doc-1", 0.2);

    const result = buildContext([candA, candB], { dynamicJaccard: true });
    // Dynamic Jaccard lowered threshold for 0.20, dropping the redundant paraphrase
    expect(result.sources).toHaveLength(1);
    expect(result.droppedDuplicates).toBe(1);
  });

  it("strictly respects the 3200 token budget and clamps safely", () => {
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
