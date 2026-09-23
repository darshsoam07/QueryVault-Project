import { describe, expect, it } from "vitest";

import {
  findBoundaryOverlap,
  isTableRow,
  isTableSeparator,
  parseHeading,
  preparePageChunks,
  recursiveSplit,
  splitTable,
} from "@/lib/chunking";

describe("boundary snapping for sliding window overlap", () => {
  it("snaps overlap to a sentence boundary when available", () => {
    const text =
      "First sentence about infrastructure. Second sentence detailing service reliability. Third sentence on incident response.";
    // With overlap target around 55 chars, it should pick the clean sentence boundary "Third sentence on incident response."
    const overlap = findBoundaryOverlap(text, 55);
    expect(overlap).toBe("Third sentence on incident response.");
  });

  it("snaps overlap to a word boundary when no sentence boundary is in range", () => {
    const text = "Continuous integration and delivery automation across cloud platforms";
    // Target 25 chars. Instead of slicing mid-word "cross cloud platforms", it should snap to word boundary
    const overlap = findBoundaryOverlap(text, 25);
    expect(overlap).not.toMatch(/^[a-z]+ing/); // Does not start with severed word fragment
    expect(overlap).toBe("across cloud platforms");
  });

  it("falls back safely to character slicing if text has no whitespace or delimiter", () => {
    const text = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const overlap = findBoundaryOverlap(text, 10);
    expect(overlap).toBe("0123456789");
  });

  it("returns empty string when overlap is zero or text is minimal", () => {
    expect(findBoundaryOverlap("Short text", 0)).toBe("");
    expect(findBoundaryOverlap("Hi", 10)).toBe("");
  });

  it("recursiveSplit preserves semantic context across chunks without cutting words", () => {
    const sentence1 = "QueryVault indexes mission critical documents with high precision.";
    const sentence2 = "Vector embeddings capture semantic similarity for unstructured queries.";
    const sentence3 = "Lexical search guarantees exact keyword matching for specific identifiers.";
    const fullText = `${sentence1} ${sentence2} ${sentence3}`;

    const chunks = recursiveSplit(fullText, 120, 40);
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk should start and end on whole words
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/^[a-z]{1,3}\s/); // No severed prefix fragment
      expect(chunk.length).toBeGreaterThan(24);
    }
  });
});

describe("Markdown pipe-table preservation", () => {
  const smallTableLines = [
    "| Service | SLA | Team |",
    "| :--- | :---: | ---: |",
    "| ingest-api | 99.9% | Reliability |",
    "| chat-api | 99.95% | Core Team |",
  ];

  it("identifies table rows and separator lines accurately", () => {
    expect(isTableRow("| Header 1 | Header 2 |")).toBe(true);
    expect(isTableRow("Just regular text")).toBe(false);
    expect(isTableSeparator("| --- | :---: |")).toBe(true);
    expect(isTableSeparator("| Data Row 1 | Data Row 2 |")).toBe(false);
  });

  it("keeps small tables atomic within a single chunk", () => {
    const chunks = splitTable(smallTableLines, 1000);
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toBe(smallTableLines.join("\n"));
  });

  it("splits large tables along whole row boundaries and repeats the header on subsequent chunks", () => {
    const largeTableLines = [
      "| ID | Component | Status |",
      "| --- | --- | --- |",
      "| 1 | Ingestion Gateway | Operational |",
      "| 2 | Reranking Utility | Operational |",
      "| 3 | Citation Verifier | Operational |",
      "| 4 | Telemetry Worker | Operational |",
    ];

    // Restrict chunkSize so only ~2 rows fit per chunk
    const chunks = splitTable(largeTableLines, 120);
    expect(chunks.length).toBeGreaterThan(1);

    const expectedHeader = "| ID | Component | Status |\n| --- | --- | --- |";
    for (const chunk of chunks) {
      expect(chunk.startsWith(expectedHeader)).toBe(true);
      // Ensure rows are complete and not cut mid-pipe
      const lines = chunk.split("\n");
      for (const line of lines) {
        expect(isTableRow(line)).toBe(true);
      }
    }
  });
});

describe("heading hierarchy and breadcrumb tracking", () => {
  it("parses markdown headings correctly", () => {
    expect(parseHeading("# Root Architecture")).toEqual({ level: 1, title: "Root Architecture" });
    expect(parseHeading("### Storage Layer ###")).toEqual({ level: 3, title: "Storage Layer" });
    expect(parseHeading("Not a heading")).toBeNull();
    expect(parseHeading(" # Invalid spaced hash")).toBeNull();
  });

  it("prefixes chunks with hierarchical breadcrumbs and maintains stack", () => {
    const pageText = [
      "# Security Policy",
      "General overview of organizational security guidelines.",
      "",
      "## Data Governance",
      "Policies governing data retention and lifecycle.",
      "",
      "### Backup Retention",
      "Backups are retained for 30 calendar days in encrypted storage.",
    ].join("\n");

    const chunks = preparePageChunks([{ page: 1, text: pageText }], 500, 50);

    expect(chunks.length).toBeGreaterThanOrEqual(3);

    // First chunk under Root
    expect(chunks[0]!.content).toContain("[Section: Security Policy]");
    expect(chunks[0]!.metadata?.breadcrumbs).toEqual(["Security Policy"]);

    // Second chunk under Data Governance
    expect(chunks[1]!.content).toContain("[Section: Security Policy > Data Governance]");
    expect(chunks[1]!.metadata?.breadcrumbs).toEqual(["Security Policy", "Data Governance"]);

    // Third chunk under Backup Retention
    expect(chunks[2]!.content).toContain(
      "[Section: Security Policy > Data Governance > Backup Retention]",
    );
    expect(chunks[2]!.metadata?.breadcrumbs).toEqual([
      "Security Policy",
      "Data Governance",
      "Backup Retention",
    ]);
    expect(chunks[2]!.metadata?.section).toBe("Backup Retention");
  });

  it("pops breadcrumb stack when a higher or equal level heading arrives", () => {
    const pageText = [
      "# Chapter 1",
      "Introductory chapter content.",
      "## Section 1.1",
      "Subsection content.",
      "# Chapter 2",
      "Second chapter should not carry previous chapter breadcrumbs.",
    ].join("\n");

    const chunks = preparePageChunks([{ page: 1, text: pageText }], 500, 50);

    const chapter2Chunk = chunks.find((c) => c.content.includes("Second chapter"));
    expect(chapter2Chunk).toBeDefined();
    expect(chapter2Chunk!.content).toContain("[Section: Chapter 2]");
    expect(chapter2Chunk!.content).not.toContain("Chapter 1");
    expect(chapter2Chunk!.metadata?.breadcrumbs).toEqual(["Chapter 2"]);
  });
});

describe("fenced code block isolation", () => {
  it("ignores markdown headings and table pipes inside code blocks", () => {
    const pageText = [
      "# Operations Guide",
      "Here is a code snippet for server deployment:",
      "```bash",
      "# This is a shell comment, NOT a document heading",
      "cat access.log | grep 404 | awk '{print $1}'",
      "```",
      "Deployment verification complete.",
    ].join("\n");

    const chunks = preparePageChunks([{ page: 1, text: pageText }], 1000, 100);

    // Verify code block chunk was not interpreted as a table or sub-heading
    const codeChunk = chunks.find((c) => c.content.includes("```bash"));
    expect(codeChunk).toBeDefined();
    expect(codeChunk!.content).toContain("# This is a shell comment");
    expect(codeChunk!.metadata?.isTable).toBe(false);
    expect(codeChunk!.metadata?.section).toBe("Operations Guide");
    expect(codeChunk!.metadata?.breadcrumbs).toEqual(["Operations Guide"]);
  });
});

describe("multi-page document continuity", () => {
  it("maintains heading breadcrumb stack across page transitions", () => {
    const pages = [
      {
        page: 1,
        text: "# Compliance Manual\n## Section A: Auditing\nAuditing procedures start on page 1.",
      },
      {
        page: 2,
        text: "Continuing auditing procedures on page 2 under the same heading.",
      },
    ];

    const chunks = preparePageChunks(pages, 500, 50);

    expect(chunks.length).toBe(2);
    expect(chunks[0]!.page).toBe(1);
    expect(chunks[0]!.index).toBe(0);
    expect(chunks[0]!.content).toContain("[Section: Compliance Manual > Section A: Auditing]");

    expect(chunks[1]!.page).toBe(2);
    expect(chunks[1]!.index).toBe(1);
    // Page 2 chunk retains section context from page 1!
    expect(chunks[1]!.content).toContain("[Section: Compliance Manual > Section A: Auditing]");
    expect(chunks[1]!.metadata?.breadcrumbs).toEqual([
      "Compliance Manual",
      "Section A: Auditing",
    ]);
  });
});
