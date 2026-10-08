/**
 * Citation contract tests — Workstream A (trust & correctness).
 *
 * The citation validator is the trust boundary between the model and the
 * user: every substantive paragraph, bullet item, numbered-list item,
 * blockquote, and substantive table row in a non-refusal answer must contain
 * at least one valid citation to a source in the request's evidence set.
 * ANY failure rejects the ENTIRE answer before render/store: the candidate
 * is discarded and the controlled grounded refusal is delivered instead.
 * Unknown ids are never stripped silently; there is no fallback to all
 * retrieved sources.
 */
import { describe, expect, it } from "vitest";

import { GROUNDED_REFUSAL } from "@/lib/chat.schema";
import {
  buildValidationTelemetry,
  chunkAnswerForEmission,
  normalizeCitationMarkers,
  orderCitedSources,
  planDelivery,
  validateCitedAnswer,
  type CitationValidationResult,
  type EvidenceSource,
} from "@/lib/retrieval";

function evidence(count: number): EvidenceSource[] {
  return Array.from({ length: count }, (_, i) => ({
    sourceId: `source_${String(i + 1).padStart(2, "0")}`,
    chunkId: `chunk-${i + 1}`,
    documentId: `doc-${i + 1}`,
    filename: `file-${i + 1}.pdf`,
    page: i + 1,
    similarityScore: 0.9 - i * 0.05,
    rerankScore: 0.8,
    snippet: `snippet ${i + 1}`,
  }));
}

const SOURCES = evidence(3);

/** The full decision flow the route runs: validate -> plan -> chunk. */
function decideAndEmit(candidate: string, sources: EvidenceSource[] = SOURCES) {
  const result = validateCitedAnswer(candidate, sources);
  const plan = planDelivery(result);
  const chunks = chunkAnswerForEmission(plan.text);
  const citedNodes = orderCitedSources(sources, plan.citedIds);
  return { result, plan, chunks, citedNodes };
}

describe("citation contract: valid answers", () => {
  it("1. one cited paragraph passes", () => {
    const result = validateCitedAnswer("The notice period is 30 days [source_01].", SOURCES);
    expect(result.valid).toBe(true);
    expect(result.failureReason).toBeNull();
    expect(result.citedSourceIds).toEqual(["source_01"]);
    expect(result.deduplicatedSourceIds).toEqual(["source_01"]);
  });

  it("2. multiple cited paragraphs pass", () => {
    const result = validateCitedAnswer(
      "The notice period is 30 days [source_01].\n\nThe fee is waived on renewal [source_02].",
      SOURCES,
    );
    expect(result.valid).toBe(true);
    expect(result.citedSourceIds).toEqual(["source_01", "source_02"]);
  });

  it("5. all numbered-list items cited passes", () => {
    const result = validateCitedAnswer(
      "1. The notice period is 30 days [source_01].\n2. The fee is waived [source_02].\n3. Renewal is automatic [source_03].",
      SOURCES,
    );
    expect(result.valid).toBe(true);
  });

  it("8. [source_1] normalizes to [source_01]", () => {
    expect(normalizeCitationMarkers("Thirty days [source_1].")).toBe("Thirty days [source_01].");
    const result = validateCitedAnswer("Thirty days [source_1].", SOURCES);
    expect(result.valid).toBe(true);
    expect(result.normalizedAnswer).toContain("[source_01]");
    expect(result.normalizedAnswer).not.toContain("[source_1]");
    expect(result.citedSourceIds).toEqual(["source_01"]);
  });

  it("10. duplicate citations are deduplicated", () => {
    const result = validateCitedAnswer(
      "Thirty days [source_01].\n\nAlso thirty days [source_01].",
      SOURCES,
    );
    expect(result.valid).toBe(true);
    expect(result.citedSourceIds).toEqual(["source_01"]);
    expect(result.deduplicatedSourceIds).toEqual(["source_01"]);
  });

  it("11. sources returned in first-appearance order", () => {
    const result = validateCitedAnswer(
      "The fee is waived [source_02]. The notice is 30 days [source_01]. Renewal [source_03].",
      SOURCES,
    );
    expect(result.valid).toBe(true);
    expect(result.citedSourceIds).toEqual(["source_02", "source_01", "source_03"]);
    expect(result.deduplicatedSourceIds).toEqual(["source_01", "source_02", "source_03"]);
  });

  it("12. heading without citation followed by cited prose passes", () => {
    const result = validateCitedAnswer(
      "## Key terms\n\nThe notice period is 30 days [source_01].",
      SOURCES,
    );
    expect(result.valid).toBe(true);
  });

  it("13. pure fenced code without citation plus cited explanatory prose passes", () => {
    const result = validateCitedAnswer(
      "The retention window is configured here [source_01]:\n\n```yaml\nretention_days: 30\n```",
      SOURCES,
    );
    expect(result.valid).toBe(true);
  });

  it("19. valid citation markers remain intact in the delivered text", () => {
    const { plan } = decideAndEmit("The notice period is 30 days [source_01].");
    expect(plan.text).toContain("[source_01]");
    expect(plan.text).not.toContain("[source_001]");
  });

  it("cited blockquote passes; cited table data rows pass", () => {
    const quoted = validateCitedAnswer(
      "> The agreement renews automatically each year [source_02].",
      SOURCES,
    );
    expect(quoted.valid).toBe(true);
    const table = validateCitedAnswer(
      "| Term | Value |\n| --- | --- |\n| Notice | 30 days [source_01] |\n| Fee | Waived [source_02] |",
      SOURCES,
    );
    expect(table.valid).toBe(true);
  });
});

describe("citation contract: rejection (fail-closed)", () => {
  it("15. model output identical to the grounded refusal is NOT trusted — bypass rejected", () => {
    // TRUST BOUNDARY: text arriving from the model — even byte-identical to
    // the fixed grounded refusal — is untrusted input and must pass strict
    // block-by-block validation. A model must not bypass the citation
    // contract by emitting the refusal sentence.
    const result = validateCitedAnswer(GROUNDED_REFUSAL, SOURCES);
    expect(result.valid).toBe(false);
    expect(result.failureReason).toBe("no_citations");
    expect(result.offendingBlockIndex).toBe(0);
    expect(result.normalizedAnswer).toBe("");
    // Near-imitations of the refusal (extra punctuation, apology prefix,
    // paraphrase) are rejected too — never treated as a trusted refusal.
    for (const imitation of [
      `${GROUNDED_REFUSAL}.`,
      `Sorry — ${GROUNDED_REFUSAL}`,
      "I can't find relevant information in the provided documents to answer this.",
      "The provided documents do not contain the information needed to answer.",
    ]) {
      const r = validateCitedAnswer(imitation, SOURCES);
      expect(r.valid).toBe(false);
      expect(r.normalizedAnswer).toBe("");
    }
    // The only trusted refusal is server-selected: planDelivery's refusal
    // substitution on the rejected candidate delivers the fixed refusal
    // with no source list and no model text.
    const plan = planDelivery(result);
    expect(plan.refused).toBe(true);
    expect(plan.text).toBe(GROUNDED_REFUSAL);
    expect(plan.citedIds).toEqual([]);
  });

  it("empty and whitespace-only model output fails closed", () => {
    for (const empty of ["", "   ", "\n\t  \n"]) {
      const result = validateCitedAnswer(empty, SOURCES);
      expect(result.valid).toBe(false);
      expect(result.failureReason).toBe("no_citations");
      expect(result.normalizedAnswer).toBe("");
      // The server-selected refusal is the only deliverable outcome.
      expect(planDelivery(result).refused).toBe(true);
      expect(planDelivery(result).text).toBe(GROUNDED_REFUSAL);
    }
  });

  it("3. first paragraph cited, second uncited -> rejects", () => {
    const result = validateCitedAnswer(
      "The notice period is 30 days [source_01].\n\nThe fee is probably waived.",
      SOURCES,
    );
    expect(result.valid).toBe(false);
    expect(result.failureReason).toBe("uncited_substantive_block");
    expect(result.offendingBlockIndex).toBe(1);
    expect(result.normalizedAnswer).toBe("");
  });

  it("4. one uncited bullet -> rejects", () => {
    const result = validateCitedAnswer(
      "- The notice period is 30 days [source_01].\n- The fee is waived.",
      SOURCES,
    );
    expect(result.valid).toBe(false);
    expect(result.failureReason).toBe("uncited_substantive_block");
    expect(result.offendingBlockIndex).toBe(1);
  });

  it("6. unknown [source_99] -> rejects, never stripped silently", () => {
    const result = validateCitedAnswer("The notice period is 30 days [source_99].", SOURCES);
    expect(result.valid).toBe(false);
    expect(result.failureReason).toBe("unknown_citation");
    expect(result.offendingCitationId).toBe("source_99");
    // The candidate is discarded wholesale: no stripped text survives.
    expect(result.normalizedAnswer).toBe("");
  });

  it("7. answer with zero citations -> rejects", () => {
    const result = validateCitedAnswer("The notice period is 30 days. The fee is waived.", SOURCES);
    expect(result.valid).toBe(false);
    expect(result.failureReason).toBe("no_citations");
  });

  it("9. citation outside the allowed evidence set -> rejects", () => {
    const oneSource = evidence(1);
    const result = validateCitedAnswer("The fee is waived [source_02].", oneSource, {
      knownSourceIds: ["source_01", "source_02", "source_03"],
    });
    expect(result.valid).toBe(false);
    expect(result.failureReason).toBe("citation_outside_evidence_set");
    expect(result.offendingCitationId).toBe("source_02");
  });

  it("14. uncited explanatory prose around code -> rejects", () => {
    const result = validateCitedAnswer(
      "Here is the config:\n\n```yaml\nretention_days: 30\n```\n\nIt keeps data for a month.",
      SOURCES,
    );
    expect(result.valid).toBe(false);
    // Zero citation markers anywhere: reported as no_citations.
    expect(result.failureReason).toBe("no_citations");
  });

  it("uncited prose beside a cited block still rejects with the block reason", () => {
    const result = validateCitedAnswer(
      "The fee is waived [source_01].\n\n```yaml\nretention_days: 30\n```\n\nIt keeps data for a month.",
      SOURCES,
    );
    expect(result.valid).toBe(false);
    expect(result.failureReason).toBe("uncited_substantive_block");
    expect(result.offendingBlockIndex).toBe(1);
  });

  it("malformed citation markers -> rejects", () => {
    for (const bad of [
      "Thirty days [source_].",
      "Thirty days [source_abc].",
      "Thirty days [source_1x].",
      "Thirty days [SOURCE_01].",
      "Thirty days [ source_01 ].",
      "Thirty days [source_01, source_02].",
    ]) {
      const result = validateCitedAnswer(bad, SOURCES);
      expect(result.valid).toBe(false);
      expect(result.failureReason).toBe("malformed_citation");
    }
  });

  it("three-digit ids are unknown citations -> rejects", () => {
    const result = validateCitedAnswer("Thirty days [source_123].", SOURCES);
    expect(result.valid).toBe(false);
    expect(result.failureReason).toBe("unknown_citation");
  });

  it("uncited blockquote and uncited table data row -> reject", () => {
    const quoted = validateCitedAnswer(
      "Cited intro [source_01].\n\n> The agreement renews automatically.",
      SOURCES,
    );
    expect(quoted.valid).toBe(false);
    expect(quoted.failureReason).toBe("uncited_substantive_block");
    expect(quoted.offendingBlockIndex).toBe(1);
    const table = validateCitedAnswer(
      "Terms [source_01].\n\n| Term | Value |\n| --- | --- |\n| Notice | 30 days |",
      SOURCES,
    );
    expect(table.valid).toBe(false);
    expect(table.failureReason).toBe("uncited_substantive_block");
  });

  it("unrelated bracketed content is not treated as a citation", () => {
    // [1] is not citation-shaped; the paragraph still needs a real citation.
    const result = validateCitedAnswer("See footnote [1] for the term.", SOURCES);
    expect(result.valid).toBe(false);
    expect(result.failureReason).toBe("no_citations");
  });

  it("markers inside fenced code are unrelated content — not validated", () => {
    const result = validateCitedAnswer(
      "The pattern is shown below [source_01].\n\n```\nuse [source_99] here\n```",
      SOURCES,
    );
    expect(result.valid).toBe(true);
  });
});

describe("citation contract: delivery plan", () => {
  it("16. invalid candidate text never reaches emitted chunks", () => {
    const candidate = "SECRET CANDIDATE: the vault code is 1234 [source_99]. Never show this.";
    const { result, plan, chunks } = decideAndEmit(candidate);
    expect(result.valid).toBe(false);
    expect(plan.refused).toBe(true);
    expect(plan.text).toBe(GROUNDED_REFUSAL);
    const emitted = chunks.join("");
    expect(emitted).toBe(GROUNDED_REFUSAL);
    expect(emitted).not.toContain("SECRET CANDIDATE");
    expect(emitted).not.toContain("source_99");
    expect(emitted).not.toContain("1234");
  });

  it("17. delivered answer equals persisted answer", () => {
    const candidate = "The notice period is 30 days [source_1].";
    const { result, plan, chunks } = decideAndEmit(candidate);
    expect(result.valid).toBe(true);
    // The route uses this single plan.text for both the streamed chunks and
    // the database insert — one value, no divergence possible.
    const delivered = chunks.join("");
    const persisted = plan.text;
    expect(delivered).toBe(persisted);
    expect(persisted).toBe(result.normalizedAnswer);
    expect(persisted).toBe("The notice period is 30 days [source_01].");
  });

  it("18. no-citation answer does not attach all retrieved sources", () => {
    const { result, plan, citedNodes } = decideAndEmit(
      "The notice period is 30 days. The fee is waived.",
    );
    expect(result.valid).toBe(false);
    expect(plan.citedIds).toEqual([]);
    // No fallback: the old `cited.length > 0 ? cited : allSources` is gone.
    expect(citedNodes).toEqual([]);
  });

  it("20. unknown markers are never briefly visible in the browser", () => {
    const { plan, chunks } = decideAndEmit(
      "Thirty days [source_01], plus a hidden [source_99] marker.",
    );
    expect(plan.refused).toBe(true);
    const emitted = chunks.join("");
    expect(emitted).not.toContain("[source_99]");
    expect(emitted).not.toContain("[source_01]");
    expect(emitted).toBe(GROUNDED_REFUSAL);
  });

  it("valid plan returns cited sources only, in first-appearance order", () => {
    const { plan, citedNodes } = decideAndEmit(
      "Fee waived [source_02]. Notice 30 days [source_01].",
    );
    expect(plan.refused).toBe(false);
    expect(citedNodes.map((s) => s.sourceId)).toEqual(["source_02", "source_01"]);
    expect(citedNodes).toHaveLength(2);
  });

  it("emission chunks reassemble the validated answer exactly", () => {
    const text = "The notice period is 30 days [source_01]. ".repeat(20).trim();
    const chunks = chunkAnswerForEmission(text);
    expect(chunks.join("")).toBe(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(240);
  });
});

describe("citation contract: safe telemetry", () => {
  it("telemetry carries only permitted fields, never content", () => {
    const result: CitationValidationResult = validateCitedAnswer(
      "Thirty days [source_99] and a secret.",
      SOURCES,
    );
    const telemetry = buildValidationTelemetry({
      requestId: "req-123",
      result,
      allowedSourceCount: SOURCES.length,
      generationAttempts: 1,
      // Deterministic: do not depend on the ambient QV_RELEASE.
      release: null,
    });
    expect(telemetry).toEqual({
      requestId: "req-123",
      success: false,
      failureReason: "unknown_citation",
      blockIndex: null,
      citationCount: 0,
      allowedSourceCount: 3,
      generationAttempts: 1,
      contractVersion: "citation-contract/v1",
      release: null,
    });
    const serialized = JSON.stringify(telemetry);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("source_99");
    for (const key of Object.keys(telemetry)) {
      expect([
        "requestId",
        "success",
        "failureReason",
        "blockIndex",
        "citationCount",
        "allowedSourceCount",
        "generationAttempts",
        "contractVersion",
        "release",
      ]).toContain(key);
    }
  });

  it("telemetry release resolves from QV_RELEASE, never invented", () => {
    const result: CitationValidationResult = validateCitedAnswer(
      "Thirty days [source_01].",
      SOURCES,
    );
    const previous = process.env["QV_RELEASE"];
    try {
      process.env["QV_RELEASE"] = "test-release-abc123";
      expect(
        buildValidationTelemetry({
          requestId: "req-env",
          result,
          allowedSourceCount: SOURCES.length,
          generationAttempts: 1,
        }).release,
      ).toBe("test-release-abc123");

      process.env["QV_RELEASE"] = "   ";
      expect(
        buildValidationTelemetry({
          requestId: "req-blank",
          result,
          allowedSourceCount: SOURCES.length,
          generationAttempts: 1,
        }).release,
      ).toBeNull();

      delete process.env["QV_RELEASE"];
      expect(
        buildValidationTelemetry({
          requestId: "req-unset",
          result,
          allowedSourceCount: SOURCES.length,
          generationAttempts: 1,
        }).release,
      ).toBeNull();
    } finally {
      if (previous === undefined) delete process.env["QV_RELEASE"];
      else process.env["QV_RELEASE"] = previous;
    }
  });

  it("telemetry release override wins over the environment", () => {
    const result: CitationValidationResult = validateCitedAnswer(
      "Thirty days [source_01].",
      SOURCES,
    );
    const telemetry = buildValidationTelemetry({
      requestId: "req-override",
      result,
      allowedSourceCount: SOURCES.length,
      generationAttempts: 1,
      release: "pinned-release",
    });
    expect(telemetry.release).toBe("pinned-release");
    expect(telemetry.contractVersion).toBe("citation-contract/v1");
  });
});
