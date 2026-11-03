import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { extractDocumentPages } from "../ingestion/document-parser.server";
import { preparePageChunks } from "../chunking";

describe("self-authored demo files through production extraction and chunking", () => {
  it.each([
    ["harbor-guide.txt", "09:30", "HBR-204"],
    ["harbor-travel.txt", "east entrance", "09:15"],
    ["meadow-guide.txt", "13:00", "MDW-909"],
  ])("preserves facts and page provenance in %s", async (file, fact, code) => {
    const pages=await extractDocumentPages(new Uint8Array(await readFile(`demo/documents/${file}`)),file!);
    const chunks=preparePageChunks(pages);
    expect(pages).toHaveLength(1);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.map(c=>c.content).join("\n")).toContain(fact);
    expect(chunks.map(c=>c.content).join("\n")).toContain(code);
    expect(chunks.every(c=>c.page===1)).toBe(true);
  });
});
