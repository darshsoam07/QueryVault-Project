// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { TraceWaterfall } from "@/components/queryvault/TraceWaterfall";

afterEach(() => {
  cleanup();
});

const sampleStages = {
  embedding: {
    latencyMs: 120,
    variants: 2,
    rewritten: true,
  },
  dense: {
    latencyMs: 350,
    count: 15,
    top: [
      { chunkId: "c1", filename: "annual-report.pdf", page: 12, similarity: 0.82, position: 0 },
      { chunkId: "c2", filename: "annual-report.pdf", page: 14, similarity: 0.74, position: 1 },
    ],
  },
  lexical: {
    latencyMs: 80,
    count: 8,
    top: [
      { chunkId: "c2", filename: "annual-report.pdf", page: 14, lexicalRank: 0.65, position: 0 },
      { chunkId: "c3", filename: "policy.pdf", page: 2, lexicalRank: 0.45, position: 1 },
    ],
  },
  fusion: {
    count: 20,
    rrfTop: [
      {
        chunkId: "c2",
        filename: "annual-report.pdf",
        page: 14,
        densePosition: 1,
        lexicalPosition: 0,
        fusionScore: 0.032,
        rerankScore: 0.88,
      },
      {
        chunkId: "c1",
        filename: "annual-report.pdf",
        page: 12,
        densePosition: 0,
        lexicalPosition: 5,
        fusionScore: 0.028,
        rerankScore: 0.76,
      },
      {
        chunkId: "c3",
        filename: "policy.pdf",
        page: 2,
        densePosition: 10,
        lexicalPosition: 1,
        fusionScore: 0.019,
        rerankScore: 0.42,
      },
    ],
  },
  rerank: {
    latencyMs: 450,
    reranker: "llm:utility-model",
    fallback: null,
    count: 12,
    top: [
      { chunkId: "c2", filename: "annual-report.pdf", page: 14, rerankScore: 0.88 },
      { chunkId: "c1", filename: "annual-report.pdf", page: 12, rerankScore: 0.76 },
    ],
  },
  gate: {
    grounded: true,
    reason: "thresholds_passed",
    bestSimilarity: 0.82,
    bestRerankScore: 0.88,
  },
  evidence: {
    count: 2,
    contextTokens: 520,
    droppedDuplicates: 1,
    sources: [
      {
        sourceId: "source_01",
        chunkId: "c2",
        filename: "annual-report.pdf",
        page: 14,
        similarity: 0.74,
        rerankScore: 0.88,
        preview: "Revenue increased by 27 percent year over year...",
      },
      {
        sourceId: "source_02",
        chunkId: "c1",
        filename: "annual-report.pdf",
        page: 12,
        similarity: 0.82,
        rerankScore: 0.76,
        preview: "Fiscal year 2024 total revenue reached 412.8M...",
      },
    ],
  },
  validation: {
    contractVersion: "citation-contract/v1",
    cited: 2,
    allowedSources: 2,
    latencyMs: 15,
  },
};

describe("TraceWaterfall Component", () => {
  it("renders relative latency Gantt bar and stage timing percentages", () => {
    render(
      <TraceWaterfall
        stages={sampleStages}
        totalLatencyMs={1015}
        citations={["source_01", "source_02"]}
        refused={false}
      />,
    );

    expect(screen.getByTestId("trace-waterfall")).toBeDefined();
    expect(screen.getByTestId("gantt-bar")).toBeDefined();

    // Verify stage labels are rendered
    expect(screen.getByText("Query Expansion")).toBeDefined();
    expect(screen.getByText("Dense Retrieval (pgvector)")).toBeDefined();
    expect(screen.getByText("Lexical Search (tsvector)")).toBeDefined();
    expect(screen.getByText("Reranking")).toBeDefined();

    // Verify ms values are formatted
    expect(screen.getByText("120 ms")).toBeDefined();
    expect(screen.getByText("350 ms")).toBeDefined();
    expect(screen.getByText("80 ms")).toBeDefined();
    expect(screen.getByText("450 ms")).toBeDefined();
  });

  it("displays prominent warning when reranker timeout fallback occurs", () => {
    const timeoutStages = {
      ...sampleStages,
      rerank: {
        ...sampleStages.rerank,
        fallback: "timeout",
      },
    };

    render(<TraceWaterfall stages={timeoutStages} totalLatencyMs={5200} refused={false} />);

    const alert = screen.getByTestId("reranker-fallback-alert");
    expect(alert).toBeDefined();
    expect(alert.textContent).toContain("Reranker Fallback Active: timeout");
    expect(alert.textContent).toContain("5000ms wall-clock ceiling");
  });

  it("displays provider-error warning when reranker provider fails", () => {
    const providerErrorStages = {
      ...sampleStages,
      rerank: {
        ...sampleStages.rerank,
        fallback: "provider-error",
      },
    };

    render(<TraceWaterfall stages={providerErrorStages} totalLatencyMs={600} refused={false} />);

    const alert = screen.getByTestId("reranker-fallback-alert");
    expect(alert).toBeDefined();
    expect(alert.textContent).toContain("Reranker Fallback Active: provider-error");
  });

  it("renders evidence gate refusal callout and below-floor flags when query is gated", () => {
    const gatedStages = {
      ...sampleStages,
      gate: {
        grounded: false,
        reason: "minTopRerankScore: 0.22 < 0.35 floor",
        bestSimilarity: 0.28,
        bestRerankScore: 0.22,
      },
    };

    render(
      <TraceWaterfall
        stages={gatedStages}
        totalLatencyMs={400}
        refused={true}
        gateReason="minTopRerankScore: 0.22 < 0.35 floor"
      />,
    );

    const refusalAlert = screen.getByTestId("evidence-gate-refusal-alert");
    expect(refusalAlert).toBeDefined();
    expect(refusalAlert.textContent).toContain("Grounded Refusal Triggered (Evidence Gated)");
    expect(refusalAlert.textContent).toContain("minTopRerankScore: 0.22 < 0.35 floor");

    // Floor check indicators
    expect(screen.getAllByText("✗ BELOW FLOOR").length).toBeGreaterThanOrEqual(1);
  });

  it("renders RRF rank shift matrix tracking promotions and demotions", () => {
    render(<TraceWaterfall stages={sampleStages} totalLatencyMs={1015} refused={false} />);

    const table = screen.getByTestId("rrf-matrix-table");
    expect(table).toBeDefined();
    expect(table.textContent).toContain("RRF Rank");
    expect(table.textContent).toContain("annual-report.pdf");

    // Check rank promotion indicator: chunk c2 started at dense pos 1, lexical pos 0, fused at rank #1 (index 0) -> delta = 0 - 0 = 0 -> "—"
    // Chunk c3 started at dense pos 10, lexical pos 1 (best = 1), fused at rank #3 (index 2) -> delta = 1 - 2 = -1 -> "↓ -1"
    expect(table.textContent).toContain("↓ -1");
  });

  it("renders cited source badges and evidence snippet previews", () => {
    render(
      <TraceWaterfall
        stages={sampleStages}
        totalLatencyMs={1015}
        citations={["source_01", "source_02"]}
        refused={false}
      />,
    );

    const citationsList = screen.getByTestId("citations-list");
    expect(citationsList.textContent).toContain("[source_01]");
    expect(citationsList.textContent).toContain("[source_02]");

    expect(screen.getByText(/Revenue increased by 27 percent/)).toBeDefined();
    expect(screen.getByText(/Fiscal year 2024 total revenue/)).toBeDefined();
  });

  it("handles null or empty stages gracefully without throwing", () => {
    expect(() => {
      render(<TraceWaterfall stages={null} totalLatencyMs={null} />);
    }).not.toThrow();

    expect(screen.getByTestId("trace-waterfall")).toBeDefined();
    expect(screen.getAllByText("No candidates retrieved.").length).toBe(2);
    expect(screen.getByText("No evidence sources delivered.")).toBeDefined();
  });
});
