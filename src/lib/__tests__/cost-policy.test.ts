import { afterEach, describe, expect, it, vi } from "vitest";
import { assertLoopbackHttpUrl, localOnlyFetch } from "../cost-policy";
import { createSupabaseFetch } from "../../integrations/supabase/api-key";
import { verifyAnswerSupport } from "../retrieval/support-verifier.server";
import {
  chatCompletion,
  createAiSdkProvider,
  embedTexts,
  requireAiProvider,
  type AiProvider,
} from "../ai-gateway.server";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("zero-cost development boundary", () => {
  it("enforces local mode at the actual Supabase transport boundary", async () => {
    vi.stubEnv("QV_LOCAL_ONLY", "1");
    const delegate = vi.fn();
    vi.stubGlobal("fetch", delegate);
    await expect(
      createSupabaseFetch("fixture-key")("https://fixture.supabase.co/rest/v1/documents"),
    ).rejects.toThrow(/Zero-cost/);
    expect(delegate).not.toHaveBeenCalled();
  });
  it.each([
    "http://localhost:54321/rest/v1/documents",
    "http://127.0.0.1:11434/v1",
    "http://[::1]:54321",
  ])("allows loopback %s", (url) => expect(() => assertLoopbackHttpUrl(url)).not.toThrow());
  it.each([
    "https://example.supabase.co",
    "http://127.0.0.1.evil.test",
    "http://localhost@evil.test",
    "http://user:pass@localhost",
    "file:///secret",
    "http://192.168.1.2",
    "https://generativelanguage.googleapis.com",
  ])("blocks remote or ambiguous endpoint %s", (url) =>
    expect(() => assertLoopbackHttpUrl(url)).toThrow(),
  );
  it("blocks before transport and forbids redirect-following", async () => {
    const delegate = vi.fn().mockResolvedValue(new Response());
    const transport = localOnlyFetch(delegate);
    await expect(transport("https://example.supabase.co")).rejects.toThrow();
    expect(delegate).not.toHaveBeenCalled();
    await transport(new Request("http://127.0.0.1:54321"), { redirect: "follow" });
    expect(delegate).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ redirect: "error" }),
    );
  });
  it("blocks all AI entry points including manually constructed providers", async () => {
    vi.stubEnv("QV_LOCAL_ONLY", "1");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const provider: AiProvider = {
      id: "gemini",
      label: "test",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      chatModel: "gemini-3.8-flash",
      utilityModel: "gemini-3.8-flash",
      embeddingModel: "gemini-embedding-001",
      embeddingDimensions: 3072,
      supportsDimensionsParam: true,
      authHeaders: () => ({}),
    };
    expect(() => requireAiProvider()).toThrow(/zero-cost/);
    expect(() => createAiSdkProvider(provider)).toThrow(/zero-cost/);
    await expect(chatCompletion(provider, {})).rejects.toThrow(/zero-cost/);
    await expect(embedTexts(["synthetic"], provider)).rejects.toThrow(/zero-cost/);
    const onResult = vi.fn();
    expect(
      await verifyAnswerSupport({
        answer: "synthetic",
        sources: [],
        model: "unused",
        signal: new AbortController().signal,
        onResult,
      }),
    ).toBe(false);
    expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "provider_unavailable",
        finishReason: "zero-cost-ai-blocked",
        attempts: 0,
      }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
