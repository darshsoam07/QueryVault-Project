import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvidenceSource } from "../retrieval/types";
const mocks = vi.hoisted(() => ({ generateText: vi.fn() }));
vi.mock("ai", () => ({ generateText: mocks.generateText }));
const sources: EvidenceSource[] = [
  {
    sourceId: "source_01",
    chunkId: "c",
    documentId: "d",
    filename: "private.txt",
    page: 1,
    snippet: "Thirty days.",
    similarityScore: 1,
    rerankScore: 1,
  },
];
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});
async function setup(signal = new AbortController().signal) {
  const { verifyAnswerSupport } = await import("../retrieval/support-verifier.server");
  const metadata = vi.fn();
  return {
    metadata,
    run: () =>
      verifyAnswerSupport({
        answer: "Thirty days [source_01].",
        sources,
        model: "test",
        signal,
        onResult: metadata,
      }),
  };
}
const unavailable = (statusCode = 503, responseHeaders = {}) =>
  Object.assign(new Error("private provider message"), {
    statusCode,
    responseHeaders,
    responseBody: JSON.stringify({
      error: { status: statusCode === 429 ? "RESOURCE_EXHAUSTED" : "UNAVAILABLE" },
    }),
  });
describe("bounded support verifier retries", () => {
  it("rejects a late success even when the deadline timer was delayed", async () => {
    mocks.generateText.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 16000);
      return { text: "SUPPORTED" };
    });
    const { run, metadata } = await setup();
    expect(await run()).toBe(false);
    expect(metadata).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: "timeout" }));
  });
  it("recovers from temporary 503 without changing the evidence payload", async () => {
    mocks.generateText
      .mockRejectedValueOnce(unavailable())
      .mockResolvedValue({ text: "SUPPORTED", finishReason: "stop" });
    const { run, metadata } = await setup();
    const result = run();
    await vi.advanceTimersByTimeAsync(501);
    expect(await result).toBe(true);
    expect(mocks.generateText).toHaveBeenCalledTimes(2);
    expect(mocks.generateText.mock.calls[0]![0].prompt).toBe(
      mocks.generateText.mock.calls[1]![0].prompt,
    );
    expect(mocks.generateText.mock.calls[0]![0].maxRetries).toBe(0);
    expect(metadata).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: "supported", attempts: 2 }),
    );
  });
  it("exhausts three 503 attempts and stays closed", async () => {
    mocks.generateText.mockRejectedValue(unavailable());
    const { run, metadata } = await setup();
    const result = run();
    await vi.advanceTimersByTimeAsync(1600);
    expect(await result).toBe(false);
    expect(mocks.generateText).toHaveBeenCalledTimes(3);
    expect(metadata).toHaveBeenLastCalledWith(
      expect.objectContaining({
        outcome: "provider_unavailable",
        httpStatus: 503,
        providerClassification: "UNAVAILABLE",
        attempts: 3,
      }),
    );
  });
  it("honors 429 Retry-After without an early retry", async () => {
    mocks.generateText
      .mockRejectedValueOnce(unavailable(429, { "retry-after": "2" }))
      .mockResolvedValue({ text: "SUPPORTED" });
    const { run } = await setup();
    const result = run();
    await vi.advanceTimersByTimeAsync(1999);
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(await result).toBe(true);
  });
  it("does not retry beyond the budget or ignore long provider guidance", async () => {
    mocks.generateText.mockRejectedValue(unavailable(503, { "Retry-After": "60" }));
    const { run, metadata } = await setup();
    expect(await run()).toBe(false);
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
    expect(metadata).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: "provider_unavailable", retryAfterMs: 60000 }),
    );
  });
  it("parses RetryInfo and HTTP dates without exposing error text", async () => {
    const { verifierErrorMetadata } = await import("../retrieval/support-verifier.server");
    const e = Object.assign(unavailable(), {
      responseHeaders: { "retry-after": new Date(Date.now() + 2000).toUTCString() },
      responseBody: JSON.stringify({
        error: {
          status: "UNAVAILABLE",
          message: "private",
          details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "3s" }],
        },
      }),
    });
    expect(verifierErrorMetadata(e)).toEqual({
      httpStatus: 503,
      providerClassification: "UNAVAILABLE",
      retryAfterMs: 3000,
    });
  });
  it("times out a hung transport", async () => {
    let settle!: (v: unknown) => void;
    mocks.generateText.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const { run, metadata } = await setup();
    const result = run();
    await vi.advanceTimersByTimeAsync(15001);
    expect(await result).toBe(false);
    expect(metadata).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: "timeout", attempts: 1 }),
    );
    settle({ text: "SUPPORTED" });
    await Promise.resolve();
  });
  it("propagates cancellation during backoff and stops new attempts", async () => {
    mocks.generateText.mockRejectedValue(unavailable());
    const controller = new AbortController();
    const { run, metadata } = await setup(controller.signal);
    const result = run();
    const assertion = expect(result).rejects.toThrow("stop");
    await vi.advanceTimersByTimeAsync(1);
    controller.abort(new Error("stop"));
    await assertion;
    await vi.advanceTimersByTimeAsync(20000);
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
    expect(metadata).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: "cancelled" }));
  });
  it.each(["UNSUPPORTED", "SUPPORTED maybe", ""])("does not retry verdict %s", async (text) => {
    mocks.generateText.mockResolvedValue({ text });
    const { run, metadata } = await setup();
    expect(await run()).toBe(false);
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
    expect(metadata).toHaveBeenLastCalledWith(
      expect.objectContaining({
        outcome: text === "UNSUPPORTED" ? "evidence_unsupported" : "provider_invalid_output",
      }),
    );
  });
  it("rejects excess concurrent verifiers without adding a retry queue", async () => {
    let settle!: (v: unknown) => void;
    const pending = new Promise((resolve) => {
      settle = resolve;
    });
    mocks.generateText.mockReturnValue(pending);
    const { run, metadata } = await setup();
    const first = run(),
      second = run();
    expect(await run()).toBe(false);
    expect(mocks.generateText).toHaveBeenCalledTimes(2);
    expect(metadata).toHaveBeenLastCalledWith(
      expect.objectContaining({
        outcome: "provider_unavailable",
        finishReason: "verifier-busy",
        attempts: 0,
      }),
    );
    settle({ text: "SUPPORTED" });
    expect(await first).toBe(true);
    expect(await second).toBe(true);
  });
  it("shares provider cooldown across calls", async () => {
    mocks.generateText.mockRejectedValue(unavailable(503, { "retry-after": "2" }));
    const controller = new AbortController();
    const { run } = await setup(controller.signal);
    const first = run();
    const assertion = expect(first).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await assertion;
    const other = await setup();
    mocks.generateText.mockResolvedValue({ text: "SUPPORTED" });
    const second = other.run();
    await vi.advanceTimersByTimeAsync(1900);
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(await second).toBe(true);
  });
});
