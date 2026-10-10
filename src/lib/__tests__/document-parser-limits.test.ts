import { describe, expect, it, vi } from "vitest";
import { PARSER_LIMITS, extractDocumentPages } from "@/lib/ingestion/document-parser.server";

describe("document-parser limits contract", () => {
  it("enforces defined bounded limits for all supported document types", () => {
    expect(PARSER_LIMITS.maxPdfPages).toBe(200);
    expect(PARSER_LIMITS.maxPageChars).toBe(25_000);
    expect(PARSER_LIMITS.maxDocxChars).toBe(500_000);
    expect(PARSER_LIMITS.maxWorkbookSheets).toBe(20);
    expect(PARSER_LIMITS.maxSheetChars).toBe(40_000);
    expect(PARSER_LIMITS.maxPptxSlides).toBe(100);
    expect(PARSER_LIMITS.maxSlideChars).toBe(20_000);
    expect(PARSER_LIMITS.maxHtmlChars).toBe(200_000);
    expect(PARSER_LIMITS.maxTotalChars).toBe(1_000_000);
  });
});

describe("text and markdown parsing limits", () => {
  it("caps text files exceeding 1,000,000 chars to maxTotalChars", async () => {
    const hugeText = "A".repeat(1_200_000);
    const bytes = new TextEncoder().encode(hugeText);
    const pages = await extractDocumentPages(bytes, "huge.txt");

    expect(pages).toHaveLength(1);
    expect(pages[0]?.page).toBe(1);
    expect(pages[0]?.text.length).toBe(PARSER_LIMITS.maxTotalChars);
  });

  it("caps markdown files exceeding 1,000,000 chars to maxTotalChars", async () => {
    const hugeMd = "# Heading\n" + "B".repeat(1_100_000);
    const bytes = new TextEncoder().encode(hugeMd);
    const pages = await extractDocumentPages(bytes, "huge.md");

    expect(pages).toHaveLength(1);
    expect(pages[0]?.page).toBe(1);
    expect(pages[0]?.text.length).toBe(PARSER_LIMITS.maxTotalChars);
  });
});

describe("HTML parsing limits", () => {
  it("strips HTML tags and caps content to maxHtmlChars (200k)", async () => {
    const longContent = "paragraph ".repeat(30_000);
    const html = `<html><body><script>alert(1)</script><div>${longContent}</div></body></html>`;
    const bytes = new TextEncoder().encode(html);
    const pages = await extractDocumentPages(bytes, "page.html");

    expect(pages).toHaveLength(1);
    expect(pages[0]?.text).not.toContain("<script>");
    expect(pages[0]?.text).not.toContain("<div>");
    expect(pages[0]?.text.length).toBeLessThanOrEqual(PARSER_LIMITS.maxHtmlChars);
  });
});

describe("PDF parsing bounds and error handling", () => {
  it("safely throws permanent error on corrupt or invalid PDF bytes", async () => {
    const corruptBytes = new Uint8Array([1, 2, 3, 4, 5]);
    await expect(extractDocumentPages(corruptBytes, "corrupt.pdf")).rejects.toMatchObject({
      code: "PARSE_FAILED",
      failureClass: "PERMANENT",
    });
  });
});

describe("image and unsupported format handling", () => {
  it("throws OCR_REQUIRED for image uploads", async () => {
    const imgBytes = new Uint8Array([137, 80, 78, 71]);
    await expect(extractDocumentPages(imgBytes, "scan.png")).rejects.toMatchObject({
      code: "OCR_REQUIRED",
      failureClass: "PERMANENT",
    });
  });

  it("throws UNSUPPORTED_FORMAT for unrecognized file extensions", async () => {
    const exeBytes = new Uint8Array([77, 90]);
    await expect(extractDocumentPages(exeBytes, "program.exe")).rejects.toMatchObject({
      code: "UNSUPPORTED_FORMAT",
      failureClass: "PERMANENT",
    });
  });
});
