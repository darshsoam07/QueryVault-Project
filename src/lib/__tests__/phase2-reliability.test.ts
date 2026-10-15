import { expandQuery } from "../retrieval/query-rewrite";
import { redactTraceContent } from "../observability/trace-privacy";
import { isSupportedDocument, isQueryableDocument } from "../documents.policy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UploadQueue } from "../upload-queue";
import { embedTexts, type AiProvider } from "../ai-gateway.server";
import { googleThinkingOptions } from "../ai-options.server";
import {
  conflictAnswer,
  findConflicts,
  unsupportedCompletenessClaim,
} from "../retrieval/conflicts";
import { extractDocumentPages } from "../ingestion/document-parser.server";
import { validateOfficeArchive } from "../ingestion/archive-policy.server";
import type { EvidenceSource } from "../retrieval/types";
import JSZip from "jszip";
const source = (documentId: string, snippet: string, sourceId: string): EvidenceSource => ({
  documentId,
  snippet,
  sourceId,
  chunkId: documentId,
  filename: `${documentId}.txt`,
  page: 1,
  similarityScore: 1,
  rerankScore: 1,
});
afterEach(() => vi.restoreAllMocks());
describe("Phase 2 reliability regressions", () => {
  it("immediately removes a cancelled queued upload even while all slots are stalled", async () => {
    const queue = new UploadQueue(1);
    let release!: () => void;
    const running = queue.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const controller = new AbortController();
    const work = vi.fn(async () => undefined);
    const waiting = queue.run(work, controller.signal);
    const assertion = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await assertion;
    expect(work).not.toHaveBeenCalled();
    release();
    await running;
  });
  it("drops nested private trace content while retaining timings and source IDs", () => {
    expect(
      redactTraceContent({
        latencyMs: 10,
        evidence: {
          sources: [
            { sourceId: "source_01", preview: "PRIVATE", filename: "private.pdf", score: 0.8 },
          ],
        },
      }),
    ).toEqual({ latencyMs: 10, evidence: { sources: [{ sourceId: "source_01", score: 0.8 }] } });
  });
  it("rejects mismatched supported MIME types and binary text", async () => {
    expect(isSupportedDocument("notes.txt", "application/pdf")).toBe(false);
    expect(isSupportedDocument("notes.txt", "application/octet-stream")).toBe(true);
    await expect(
      extractDocumentPages(new Uint8Array([65, 0, 66]), "notes.txt"),
    ).rejects.toMatchObject({ code: "BAD_TEXT_ENCODING" });
  });
  it("a synchronous task failure releases the slot", async () => {
    const queue = new UploadQueue(1);
    await expect(
      queue.run(() => {
        throw new Error("sync");
      }),
    ).rejects.toThrow("sync");
    await expect(queue.run(async () => 1)).resolves.toBe(1);
  });
  it.each(["gemini", "openai-compatible"])(
    "bounds stalled embedding HTTP requests for %s",
    async (id) => {
      vi.spyOn(globalThis, "fetch").mockImplementation(
        async (_url, init) =>
          new Promise((_resolve, reject) => {
            const signal = init?.signal;
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      );
      const provider = {
        id,
        baseUrl: "https://provider.test",
        embeddingModel: "fixture",
        embeddingDimensions: 1,
        authHeaders: () => ({}),
      } as AiProvider;
      await expect(
        embedTexts(["private fixture"], provider, { timeoutMs: 5 }),
      ).rejects.toMatchObject({ status: 504 });
    },
  );
  it("does not degrade a custom caller abort into query-rewrite fallback", async () => {
    const controller = new AbortController();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_url, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          }),
        ),
    );
    const provider = {
      id: "openai-compatible",
      baseUrl: "https://provider.test",
      utilityModel: "fixture",
      authHeaders: () => ({}),
    } as AiProvider;
    const result = expandQuery({
      question: "Expand this question",
      provider,
      strategy: "always",
      signal: controller.signal,
    });
    const assertion = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort("custom-reason");
    await assertion;
  });
  it("uses Gemini thinking levels for current models and budgets for 2.5", () => {
    expect(googleThinkingOptions("gemini-3.8-flash")).toEqual({
      google: { thinkingConfig: { thinkingLevel: "low" } },
    });
    expect(googleThinkingOptions("gemini-2.5-flash")).toEqual({
      google: { thinkingConfig: { thinkingBudget: 0 } },
    });
  });
  it("identifies differing cited numeric statements locally", () => {
    const sources = [
      source("a", "Notice period: 30 days.", "source_01"),
      source("b", "Notice period: 60 days.", "source_02"),
    ];
    const conflicts = findConflicts("What is the notice period?", sources);
    expect(conflicts).toHaveLength(1);
    expect(conflictAnswer(conflicts)).toContain('"Notice period: 30 days." [source_01]');
    expect(conflictAnswer(conflicts)).toContain('"Notice period: 60 days." [source_02]');
    expect(findConflicts("What is revenue?", sources)).toHaveLength(0);
  });
  it("does not treat equivalent numeric formats or different units as contradictions", () => {
    expect(
      findConflicts("What is revenue?", [
        source("a", "Revenue: 1000 USD.", "source_01"),
        source("b", "Revenue: 1,000.00 dollars.", "source_02"),
      ]),
    ).toHaveLength(0);
    expect(
      findConflicts("What is the duration?", [
        source("a", "Duration: 30 days.", "source_01"),
        source("b", "Duration: 1 month.", "source_02"),
      ]),
    ).toHaveLength(0);
  });
  it("does not infer universal agreement from a retrieved sample", () => {
    expect(unsupportedCompletenessClaim("All documents agree there are no conflicts.")).toBe(true);
    expect(unsupportedCompletenessClaim("Revenue is 10 dollars [source_01].")).toBe(false);
  });
  it("rejects fake Office extension and unsafe expanded archives before parsing", async () => {
    await expect(
      extractDocumentPages(new TextEncoder().encode("not a zip"), "fake.xlsx"),
    ).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
    const zip = new JSZip();
    zip.file("word/document.xml", "x".repeat(2_000_000));
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    expect(() => validateOfficeArchive(bytes, "word/document.xml")).toThrow(
      "safe extraction limits",
    );
  });
  it("accepts a bounded valid XLSX archive and keeps worksheet locators", async () => {
    const XLSX = await import("xlsx");
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["Item", "Amount"],
        ["Widget", 123],
      ]),
      "Budget",
    );
    const bytes = new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }));
    const pages = await extractDocumentPages(bytes, "budget.xlsx");
    expect(pages[0]?.text).toContain("Sheet: Budget");
    expect(pages[0]?.text).toContain("Widget,123");
  });
  it("requires reindexing old presentation locators while preserving other READY documents", () => {
    expect(isQueryableDocument({ status: "ready", filename: "old.pptx", parser_version: 1 })).toBe(
      false,
    );
    expect(isQueryableDocument({ status: "ready", filename: "new.pptx", parser_version: 2 })).toBe(
      true,
    );
    expect(isQueryableDocument({ status: "ready", filename: "old.pdf", parser_version: 1 })).toBe(
      true,
    );
  });
  it("uses actual presentation order instead of slide filenames for locators", async () => {
    const zip = new JSZip();
    zip.file(
      "ppt/presentation.xml",
      '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst></p:presentation>',
    );
    zip.file(
      "ppt/_rels/presentation.xml.rels",
      '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>',
    );
    zip.file("ppt/slides/slide1.xml", "<a:t>Second displayed slide</a:t>");
    zip.file("ppt/slides/slide2.xml", "<a:t>First displayed slide &amp; evidence</a:t>");
    const pages = await extractDocumentPages(
      await zip.generateAsync({ type: "uint8array" }),
      "ordered.pptx",
    );
    expect(pages[0]).toEqual({ page: 1, text: "First displayed slide & evidence" });
    expect(pages[1]).toEqual({ page: 2, text: "Second displayed slide" });
  });
  it("extracts a bounded valid DOCX original without changing the parser", async () => {
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    );
    zip.file(
      "_rels/.rels",
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    );
    zip.file(
      "word/document.xml",
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>The notice period is thirty days.</w:t></w:r></w:p></w:body></w:document>',
    );
    const pages = await extractDocumentPages(
      await zip.generateAsync({ type: "uint8array" }),
      "fixture.docx",
    );
    expect(pages[0]?.text).toContain("The notice period is thirty days.");
  });
  it("does not log upstream content echoed in an embedding error", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "PRIVATE_DOCUMENT_SENTINEL" } }), {
        status: 503,
      }),
    );
    const provider = {
      id: "openai-compatible",
      baseUrl: "https://provider.test",
      embeddingModel: "fixture",
      embeddingDimensions: 1,
      authHeaders: () => ({}),
    } as AiProvider;
    await expect(embedTexts(["private"], provider)).rejects.toThrow();
    expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE_DOCUMENT_SENTINEL");
  });
});
