import { beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  numPages: 201,
  destroy: vi.fn(async () => undefined),
  extract: vi.fn(),
}));
vi.mock("unpdf", () => ({
  getDocumentProxy: async () => ({
    numPages: fixture.numPages,
    loadingTask: { destroy: fixture.destroy },
  }),
  extractText: fixture.extract,
}));
import { extractDocumentPages } from "../ingestion/document-parser.server";
beforeEach(() => {
  vi.clearAllMocks();
  fixture.numPages = 201;
});
describe("PDF extraction resource bounds", () => {
  it("rejects excessive page counts before extraction and destroys the loading task", async () => {
    await expect(
      extractDocumentPages(new TextEncoder().encode("%PDF-1.7 fixture"), "large.pdf"),
    ).rejects.toMatchObject({ code: "PARSER_LIMIT" });
    expect(fixture.extract).not.toHaveBeenCalled();
    expect(fixture.destroy).toHaveBeenCalledOnce();
  });
  it("caps aggregate extracted characters and preserves real page positions", async () => {
    fixture.numPages = 50;
    fixture.extract.mockResolvedValue({
      text: Array.from({ length: 50 }, () => "x".repeat(25000)),
    });
    const pages = await extractDocumentPages(
      new TextEncoder().encode("%PDF-1.7 fixture"),
      "bounded.pdf",
    );
    expect(pages.reduce((sum, page) => sum + page.text.length, 0)).toBe(1_000_000);
    expect(pages[39]?.page).toBe(40);
    expect(fixture.destroy).toHaveBeenCalledOnce();
  });
});
