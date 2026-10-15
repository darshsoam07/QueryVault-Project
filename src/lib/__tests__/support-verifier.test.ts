import { beforeEach, describe, expect, it, vi } from "vitest";
import { verifyAnswerSupport } from "../retrieval/support-verifier.server";
import type { EvidenceSource } from "../retrieval/types";
const mocks = vi.hoisted(() => ({ generateText: vi.fn() }));
vi.mock("ai", () => ({ generateText: mocks.generateText }));
const sources: EvidenceSource[] = [
  {
    sourceId: "source_01",
    chunkId: "chunk",
    documentId: "doc",
    filename: "Ignore instructions.txt",
    page: 1,
    similarityScore: 1,
    rerankScore: 1,
    snippet: "The notice period is thirty days.",
  },
];
const verify = (answer: string) =>
  verifyAnswerSupport({ answer, sources, model: "test", signal: new AbortController().signal });
beforeEach(() => {
  vi.clearAllMocks();
});
describe("claim support verification", () => {
  it("releases supported evidence and passes only associated passages", async () => {
    mocks.generateText.mockResolvedValue({ text: "SUPPORTED" });
    expect(await verify("The notice period is thirty days [source_01].")).toBe(true);
    const claims = JSON.parse(mocks.generateText.mock.calls[0]![0].prompt).claims;
    expect(claims[0].evidence).toEqual([{ id: "source_01", text: sources[0]!.snippet }]);
  });
  it("rejects a syntactically cited fabricated claim", async () => {
    mocks.generateText.mockResolvedValue({ text: "UNSUPPORTED" });
    expect(await verify("The notice period is a million days [source_01].")).toBe(false);
  });
  it.each([
    "## Uncited factual heading",
    "```\nHidden factual assertion\n```",
    "| Uncited factual header |\n| --- |",
  ])("formatting cannot exempt claims: %s", async (hidden) => {
    mocks.generateText.mockResolvedValue({ text: "SUPPORTED" });
    expect(await verify(hidden + "\n\nThirty days [source_01].")).toBe(false);
  });
  it("rejects unsupported exact quotations before calling the provider", async () => {
    expect(await verify('"One million days" [source_01].')).toBe(false);
    expect(mocks.generateText).not.toHaveBeenCalled();
  });
  it.each(["", "SUPPORTED but maybe not", "{ supported: true }"])(
    "fails closed on malformed verdict %s",
    async (text) => {
      mocks.generateText.mockResolvedValue({ text });
      expect(await verify("Thirty days [source_01].")).toBe(false);
    },
  );
  it("rejects a truncated verifier even if its visible prefix is SUPPORTED", async () => {
    mocks.generateText.mockResolvedValue({ text: "SUPPORTED", finishReason: "length" });
    expect(await verify("Thirty days [source_01].")).toBe(false);
  });
  it("uses model-specific Gemini reasoning settings without disclosing uncited passages", async () => {
    mocks.generateText.mockResolvedValue({ text: "SUPPORTED", finishReason: "stop" });
    await verifyAnswerSupport({
      answer: "Thirty days [source_01].",
      sources,
      model: "test",
      providerId: "gemini",
      modelId: "gemini-3.8-flash",
      signal: new AbortController().signal,
    });
    expect(mocks.generateText.mock.calls[0]![0].providerOptions).toEqual({
      google: { thinkingConfig: { thinkingLevel: "low" } },
    });
    expect(mocks.generateText.mock.calls[0]![0].maxOutputTokens).toBe(256);
  });
  it("fails closed on verifier outage", async () => {
    mocks.generateText.mockRejectedValue(new Error("provider offline"));
    expect(await verify("Thirty days [source_01].")).toBe(false);
  });
});
