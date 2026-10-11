import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  EMBEDDING_DIMENSIONS,
  GatewayError,
  chatCompletion,
  describeAiProvider,
  embedTexts,
  gatewayMessageForStatus,
  parseProviderErrorBody,
  requireAiProvider,
  toVectorLiteral,
  type AiProvider,
} from "@/lib/ai-gateway.server";
import {
  classifyError,
  isCreditsOrQuotaExhausted,
  isInvalidCredentialsError,
  isRetryable,
  backoffSeconds,
} from "@/lib/ingestion/contract";

describe("Gemini Provider Configuration Validation", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env["AI_PROVIDER"];
    delete process.env["GEMINI_API_KEY"];
    delete process.env["OPENAI_API_KEY"];
    delete process.env["LOVABLE_API_KEY"];
    delete process.env["AI_BASE_URL"];
    delete process.env["GEMINI_BASE_URL"];
    delete process.env["AI_CHAT_MODEL"];
    delete process.env["AI_UTILITY_MODEL"];
    delete process.env["AI_EMBEDDING_MODEL"];
    delete process.env["AI_EMBEDDING_DIMENSIONS"];
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("resolves Gemini provider when AI_PROVIDER=gemini and GEMINI_API_KEY is set", () => {
    process.env["AI_PROVIDER"] = "gemini";
    process.env["GEMINI_API_KEY"] = "AIzaSyTestKeySecret123";

    const provider = requireAiProvider();
    expect(provider.id).toBe("gemini");
    expect(provider.label).toBe("Google Gemini");
    expect(provider.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(provider.chatModel).toBe("gemini-3.8-flash");
    expect(provider.utilityModel).toBe("gemini-3.8-flash");
    expect(provider.embeddingModel).toBe("gemini-embedding-001");
    expect(provider.embeddingDimensions).toBe(3072);
    expect(provider.supportsDimensionsParam).toBe(true);

    // Auth header must use x-goog-api-key without serializing the key directly
    const headers = provider.authHeaders();
    expect(headers).toEqual({ "x-goog-api-key": "AIzaSyTestKeySecret123" });
    expect(JSON.stringify(provider)).not.toContain("AIzaSyTestKeySecret123");
  });

  it("infers Gemini provider when only GEMINI_API_KEY is present without AI_PROVIDER", () => {
    process.env["GEMINI_API_KEY"] = "AIzaSyTestKeyInferred";

    const provider = requireAiProvider();
    expect(provider.id).toBe("gemini");
    expect(provider.label).toBe("Google Gemini");
  });

  it("fails closed when AI_PROVIDER=gemini but GEMINI_API_KEY is missing", () => {
    process.env["AI_PROVIDER"] = "gemini";

    expect(() => requireAiProvider()).toThrowError(GatewayError);
    expect(() => requireAiProvider()).toThrow("AI is not configured for this workspace.");

    const desc = describeAiProvider();
    expect(desc.configured).toBe(false);
  });

  it("rejects embedding width mismatch when AI_EMBEDDING_DIMENSIONS is not 3072", () => {
    process.env["AI_PROVIDER"] = "gemini";
    process.env["GEMINI_API_KEY"] = "AIzaSyTestKey";
    process.env["AI_EMBEDDING_DIMENSIONS"] = "768";

    expect(() => requireAiProvider()).toThrowError(GatewayError);
    expect(() => requireAiProvider()).toThrow("Embedding width mismatch");
  });

  it("rejects text-embedding-004 model because it cannot output 3072 dimensions for halfvec(3072)", () => {
    process.env["AI_PROVIDER"] = "gemini";
    process.env["GEMINI_API_KEY"] = "AIzaSyTestKey";
    process.env["AI_EMBEDDING_MODEL"] = "text-embedding-004";

    expect(() => requireAiProvider()).toThrowError(GatewayError);
    expect(() => requireAiProvider()).toThrow("maximum output dimension of 768");
  });

  it("allows overriding Gemini chat and utility models via environment", () => {
    process.env["AI_PROVIDER"] = "gemini";
    process.env["GEMINI_API_KEY"] = "AIzaSyTestKey";
    process.env["AI_CHAT_MODEL"] = "gemini-2.0-flash";
    process.env["AI_UTILITY_MODEL"] = "gemini-2.0-flash-lite";

    const provider = requireAiProvider();
    expect(provider.chatModel).toBe("gemini-2.0-flash");
    expect(provider.utilityModel).toBe("gemini-2.0-flash-lite");
  });

  it("allows overriding base URL via GEMINI_BASE_URL or AI_BASE_URL", () => {
    process.env["AI_PROVIDER"] = "gemini";
    process.env["GEMINI_API_KEY"] = "AIzaSyTestKey";
    process.env["GEMINI_BASE_URL"] = "https://custom-gateway.example.com/v1beta";

    const provider = requireAiProvider();
    expect(provider.baseUrl).toBe("https://custom-gateway.example.com/v1beta");
  });

  it("resolves Gemini provider even when AI_PROVIDER is wrapped in quotes", () => {
    process.env["AI_PROVIDER"] = '"gemini"';
    process.env["GEMINI_API_KEY"] = "AIzaSyTestKey";

    const provider = requireAiProvider();
    expect(provider.id).toBe("gemini");
    expect(provider.embeddingModel).toBe("gemini-embedding-001");
    expect(provider.chatModel).toBe("gemini-3.8-flash");

    // Single quotes test
    process.env["AI_PROVIDER"] = "'gemini'";
    const singleQuoteProvider = requireAiProvider();
    expect(singleQuoteProvider.id).toBe("gemini");
  });

  it("prioritizes AI_PROVIDER=gemini over OPENAI_API_KEY when both are set", () => {
    process.env["AI_PROVIDER"] = "gemini";
    process.env["GEMINI_API_KEY"] = "AIzaSyTestKey";
    process.env["OPENAI_API_KEY"] = "sk-proj-test-openai-key";

    const provider = requireAiProvider();
    expect(provider.id).toBe("gemini");
    expect(provider.label).toBe("Google Gemini");
    expect(provider.chatModel).toBe("gemini-3.8-flash");
    expect(provider.embeddingModel).toBe("gemini-embedding-001");
  });

  it("safely falls back to gemini-embedding-001 if AI_EMBEDDING_MODEL holds an OpenAI model name", () => {
    process.env["AI_PROVIDER"] = "gemini";
    process.env["GEMINI_API_KEY"] = "AIzaSyTestKey";
    process.env["AI_EMBEDDING_MODEL"] = "text-embedding-3-large";

    const provider = requireAiProvider();
    expect(provider.id).toBe("gemini");
    expect(provider.embeddingModel).toBe("gemini-embedding-001");
  });

  it("supports provider-specific GEMINI_EMBEDDING_MODEL and GEMINI_CHAT_MODEL overrides", () => {
    process.env["AI_PROVIDER"] = "gemini";
    process.env["GEMINI_API_KEY"] = "AIzaSyTestKey";
    process.env["GEMINI_EMBEDDING_MODEL"] = "gemini-embedding-experimental";
    process.env["GEMINI_CHAT_MODEL"] = "gemini-2.0-flash-exp";

    const provider = requireAiProvider();
    expect(provider.embeddingModel).toBe("gemini-embedding-experimental");
    expect(provider.chatModel).toBe("gemini-2.0-flash-exp");
  });
});

describe("Gemini Chat Completion via Google REST API", () => {
  const fakeGeminiProvider: AiProvider = {
    id: "gemini",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    chatModel: "gemini-3.8-flash",
    utilityModel: "gemini-3.8-flash",
    embeddingModel: "gemini-embedding-001",
    embeddingDimensions: 3072,
    supportsDimensionsParam: true,
    authHeaders: () => ({ "x-goog-api-key": "fake-gemini-key" }),
  };

  it("translates OpenAI-style messages into Gemini generateContent schema and returns candidate text", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: Record<string, unknown> = {};

    const mockFetch = vi.fn().mockImplementation(async (url, init) => {
      capturedUrl = String(url);
      capturedMethod = init?.method ?? "GET";
      capturedHeaders = init?.headers as Record<string, string>;
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;

      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [{ text: '{"queries":["q1","q2"]}' }],
                role: "model",
              },
              finishReason: "STOP",
            },
          ],
        }),
      };
    });

    vi.stubGlobal("fetch", mockFetch);

    const result = await chatCompletion(fakeGeminiProvider, {
      model: "gemini-3.8-flash",
      temperature: 0.2,
      max_tokens: 500,
      messages: [
        { role: "system", content: "You are a reranker." },
        { role: "user", content: "Rank these documents." },
      ],
    });

    expect(capturedUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
    );
    expect(capturedMethod).toBe("POST");
    expect(capturedHeaders["x-goog-api-key"]).toBe("fake-gemini-key");
    expect(capturedHeaders["Content-Type"]).toBe("application/json");

    // Verify Google Gemini request schema
    expect(capturedBody["systemInstruction"]).toEqual({
      parts: [{ text: "You are a reranker." }],
    });
    expect(capturedBody["contents"]).toEqual([
      {
        role: "user",
        parts: [{ text: "Rank these documents." }],
      },
    ]);
    expect(capturedBody["generationConfig"]).toEqual({
      temperature: 0.2,
      maxOutputTokens: 500,
    });

    expect(result).toBe('{"queries":["q1","q2"]}');
  });

  it("maps assistant message to model role in Gemini schema", async () => {
    let capturedBody: Record<string, unknown> = {};
    const mockFetch = vi.fn().mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: "Answer" }] } }],
        }),
      };
    });
    vi.stubGlobal("fetch", mockFetch);

    await chatCompletion(fakeGeminiProvider, {
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
        { role: "user", content: "Can you help?" },
      ],
    });

    const contents = capturedBody["contents"] as Array<{
      role: string;
      parts: Array<{ text: string }>;
    }>;
    expect(contents).toHaveLength(3);
    expect(contents[0]?.role).toBe("user");
    expect(contents[1]?.role).toBe("model");
    expect(contents[2]?.role).toBe("user");
  });
});

describe("Gemini Embeddings via Google REST API", () => {
  const fakeGeminiProvider: AiProvider = {
    id: "gemini",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    chatModel: "gemini-3.8-flash",
    utilityModel: "gemini-3.8-flash",
    embeddingModel: "gemini-embedding-001",
    embeddingDimensions: 3072,
    supportsDimensionsParam: true,
    authHeaders: () => ({ "x-goog-api-key": "fake-gemini-key" }),
  };

  it("calls batchEmbedContents with outputDimensionality=3072 and parses embeddings", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: Record<string, unknown> = {};

    const dummy3072 = Array.from({ length: 3072 }, (_, i) => i * 0.0001);

    const mockFetch = vi.fn().mockImplementation(async (url, init) => {
      capturedUrl = String(url);
      capturedHeaders = init?.headers as Record<string, string>;
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;

      return {
        ok: true,
        status: 200,
        json: async () => ({
          embeddings: [{ values: dummy3072 }, { values: dummy3072 }],
        }),
      };
    });
    vi.stubGlobal("fetch", mockFetch);

    const vectors = await embedTexts(["chunk one", "chunk two"], fakeGeminiProvider);

    expect(capturedUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents",
    );
    expect(capturedHeaders["x-goog-api-key"]).toBe("fake-gemini-key");

    const requests = capturedBody["requests"] as Array<{
      model: string;
      content: { parts: Array<{ text: string }> };
      outputDimensionality: number;
    }>;
    expect(requests).toHaveLength(2);
    expect(requests[0]?.model).toBe("models/gemini-embedding-001");
    expect(requests[0]?.content.parts[0]?.text).toBe("chunk one");
    expect(requests[0]?.outputDimensionality).toBe(3072);
    expect(requests[1]?.content.parts[0]?.text).toBe("chunk two");
    expect(requests[1]?.outputDimensionality).toBe(3072);

    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(3072);
    expect(vectors[1]).toHaveLength(3072);
  });

  it("returns empty array for empty inputs without calling API", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const result = await embedTexts([], fakeGeminiProvider);
    expect(result).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects embeddings when vector dimensionality is not 3072", async () => {
    const wrongLength768 = Array.from({ length: 768 }, () => 0.01);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        embeddings: [{ values: wrongLength768 }],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await expect(embedTexts(["text"], fakeGeminiProvider)).rejects.toThrow(
      "Embedding model returned 768 dimensions, expected 3072",
    );
  });

  it("rejects embeddings containing non-finite numbers (NaN or Infinity)", async () => {
    const corrupted = Array.from({ length: 3072 }, () => 0.01);
    corrupted[10] = NaN;

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        embeddings: [{ values: corrupted }],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await expect(embedTexts(["text"], fakeGeminiProvider)).rejects.toThrow("non-finite numbers");
  });

  it("rejects when embedding count does not match input count", async () => {
    const dummy3072 = Array.from({ length: 3072 }, () => 0.01);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        embeddings: [{ values: dummy3072 }], // 1 embedding returned for 2 inputs
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await expect(embedTexts(["text1", "text2"], fakeGeminiProvider)).rejects.toThrow(
      "Embedding service returned an unexpected response.",
    );
  });

  it("formats vector literal compatible with PostgreSQL halfvec(3072)", () => {
    const vector = [0.123, -0.456, 0.789];
    const literal = toVectorLiteral(vector);
    expect(literal).toBe("[0.123,-0.456,0.789]");
  });
});

describe("Gemini Error Classification and Retry Logic", () => {
  it("parses Google Gemini error envelope with status and details", () => {
    const raw = JSON.stringify({
      error: {
        code: 400,
        message: "API key not valid. Please pass a valid API key.",
        status: "INVALID_ARGUMENT",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "API_KEY_INVALID",
            domain: "googleapis.com",
          },
        ],
      },
    });

    const parsed = parseProviderErrorBody(raw);
    expect(parsed.code).toBe("400");
    expect(parsed.type).toBe("INVALID_ARGUMENT");
    expect(parsed.rawMessage).toContain("API key not valid");
  });

  it("classifies Google invalid API key (400 or 403) as permanent INVALID_CREDENTIALS and never retries", () => {
    const errorBody = {
      error: {
        code: 400,
        message: "API key not valid. Please pass a valid API key.",
        status: "INVALID_ARGUMENT",
      },
    };
    const parsed = parseProviderErrorBody(JSON.stringify(errorBody));
    const gatewayError = new GatewayError(gatewayMessageForStatus(400, parsed), 400, {
      code: parsed.code,
      errorType: parsed.type,
      rawMessage: parsed.rawMessage,
    });

    const classified = classifyError(gatewayError);
    expect(classified.code).toBe("INVALID_CREDENTIALS");
    expect(classified.failureClass).toBe("PERMANENT");
    expect(isRetryable(classified, 1)).toBe(false);
  });

  it("classifies Google unregistered caller / permission denied as permanent INVALID_CREDENTIALS", () => {
    const errorBody = {
      error: {
        code: 403,
        message:
          "Method doesn't allow unregistered callers (callers without established identity).",
        status: "PERMISSION_DENIED",
      },
    };
    const parsed = parseProviderErrorBody(JSON.stringify(errorBody));
    const gatewayError = new GatewayError(gatewayMessageForStatus(403, parsed), 403, {
      code: parsed.code,
      errorType: parsed.type,
      rawMessage: parsed.rawMessage,
    });

    const classified = classifyError(gatewayError);
    expect(classified.code).toBe("INVALID_CREDENTIALS");
    expect(classified.failureClass).toBe("PERMANENT");
    expect(isRetryable(classified, 1)).toBe(false);
  });

  it("classifies Google per-minute rate limit 429 as retryable RATE_LIMITED with exponential backoff", () => {
    const errorBody = {
      error: {
        code: 429,
        message: "Resource has been exhausted (e.g. check quota).",
        status: "RESOURCE_EXHAUSTED",
      },
    };
    const parsed = parseProviderErrorBody(JSON.stringify(errorBody));
    const gatewayError = new GatewayError(gatewayMessageForStatus(429, parsed), 429, {
      code: parsed.code,
      errorType: parsed.type,
      rawMessage: parsed.rawMessage,
    });

    const classified = classifyError(gatewayError);
    expect(classified.code).toBe("RATE_LIMITED");
    expect(classified.failureClass).toBe("RESOURCE_LIMIT");
    expect(isRetryable(classified, 1)).toBe(true);
    expect(isRetryable(classified, 2)).toBe(true);

    const backoff = backoffSeconds(1, classified.failureClass);
    expect(backoff).toBeGreaterThanOrEqual(30);
  });

  it("classifies Google daily quota exceeded as permanent CREDITS_EXHAUSTED and never retries", () => {
    const errorBody = {
      error: {
        code: 429,
        message: "Quota exceeded for quota metric 'Generate Content API requests per day'",
        status: "RESOURCE_EXHAUSTED",
      },
    };
    const parsed = parseProviderErrorBody(JSON.stringify(errorBody));
    const gatewayError = new GatewayError(gatewayMessageForStatus(429, parsed), 429, {
      code: parsed.code,
      errorType: parsed.type,
      rawMessage: parsed.rawMessage,
    });

    const classified = classifyError(gatewayError);
    expect(classified.code).toBe("CREDITS_EXHAUSTED");
    expect(classified.failureClass).toBe("PERMANENT");
    expect(isRetryable(classified, 1)).toBe(false);
  });

  it("classifies Google 503 transient error as retryable UPSTREAM_ERROR", () => {
    const gatewayError = new GatewayError(gatewayMessageForStatus(503), 503);
    const classified = classifyError(gatewayError);
    expect(classified.code).toBe("UPSTREAM_ERROR");
    expect(classified.failureClass).toBe("DEPENDENCY");
    expect(isRetryable(classified, 1)).toBe(true);
  });
});

describe("Provider Switching Without OpenAI Regression", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env["AI_CHAT_MODEL"];
    delete process.env["AI_UTILITY_MODEL"];
    delete process.env["AI_EMBEDDING_MODEL"];
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("preserves OpenAI provider behavior and wire protocol when AI_PROVIDER=openai", async () => {
    process.env["AI_PROVIDER"] = "openai";
    process.env["OPENAI_API_KEY"] = "sk-proj-test-key";
    delete process.env["GEMINI_API_KEY"];

    const provider = requireAiProvider();
    expect(provider.id).toBe("openai");
    expect(provider.baseUrl).toBe("https://api.openai.com/v1");
    expect(provider.chatModel).toBe("gpt-4o");
    expect(provider.embeddingModel).toBe("text-embedding-3-large");

    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};

    const mockFetch = vi.fn().mockImplementation(async (url, init) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "OpenAI response" } }],
        }),
      };
    });
    vi.stubGlobal("fetch", mockFetch);

    const answer = await chatCompletion(provider, {
      model: "gpt-4o",
      messages: [{ role: "user", content: "test" }],
    });

    expect(capturedUrl).toBe("https://api.openai.com/v1/chat/completions");
    expect(capturedBody["messages"]).toEqual([{ role: "user", content: "test" }]);
    expect(answer).toBe("OpenAI response");
  });

  it("proves AI_PROVIDER=gemini selects Gemini for both embedding generation and chat", async () => {
    process.env["AI_PROVIDER"] = "gemini";
    process.env["GEMINI_API_KEY"] = "AIzaSyTestSecret123";
    process.env["OPENAI_API_KEY"] = "sk-proj-test-key";

    const provider = requireAiProvider();
    expect(provider.id).toBe("gemini");
    expect(provider.chatModel).toBe("gemini-3.8-flash");
    expect(provider.embeddingModel).toBe("gemini-embedding-001");

    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};

    const mockFetch = vi.fn().mockImplementation(async (url, init) => {
      capturedUrl = String(url);
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;

      if (capturedUrl.includes("batchEmbedContents")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            embeddings: [{ values: new Array(3072).fill(0.01) }],
          }),
        };
      }

      if (capturedUrl.includes("generateContent")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: "Gemini response" }] } }],
          }),
        };
      }

      return { ok: false, status: 404, text: async () => "Not Found" };
    });
    vi.stubGlobal("fetch", mockFetch);

    // 1. Embedding generation selects Gemini
    const embeddings = await embedTexts(["Test text for Gemini"], provider);
    expect(capturedUrl).toContain(
      "generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents",
    );
    expect(capturedHeaders["x-goog-api-key"]).toBe("AIzaSyTestSecret123");
    expect(embeddings).toHaveLength(1);
    expect(embeddings[0]).toHaveLength(3072);

    // 2. Chat completion selects Gemini
    const chatResponse = await chatCompletion(provider, {
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(capturedUrl).toContain(
      "generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
    );
    expect(capturedHeaders["x-goog-api-key"]).toBe("AIzaSyTestSecret123");
    expect(chatResponse).toBe("Gemini response");
  });

  it("merges consecutive same-role messages into alternating turns for Gemini chat completion", async () => {
    process.env["AI_PROVIDER"] = "gemini";
    process.env["GEMINI_API_KEY"] = "AIzaSyTestSecret123";

    const provider = requireAiProvider();
    let capturedBody: Record<string, unknown> = {};

    const mockFetch = vi.fn().mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: "merged response" }] } }],
        }),
      };
    });
    vi.stubGlobal("fetch", mockFetch);

    await chatCompletion(provider, {
      messages: [
        { role: "system", content: "system instructions" },
        { role: "user", content: "first user part" },
        { role: "user", content: "second user part" },
        { role: "assistant", content: "first model part" },
        { role: "assistant", content: "second model part" },
        { role: "user", content: "third user part" },
      ],
    });

    expect(capturedBody["systemInstruction"]).toEqual({
      parts: [{ text: "system instructions" }],
    });

    expect(capturedBody["contents"]).toEqual([
      {
        role: "user",
        parts: [{ text: "first user part" }, { text: "second user part" }],
      },
      {
        role: "model",
        parts: [{ text: "first model part" }, { text: "second model part" }],
      },
      {
        role: "user",
        parts: [{ text: "third user part" }],
      },
    ]);
  });
});

describe("Live Integration Tests (Optional)", () => {
  const liveKey = process.env["GEMINI_API_KEY"];
  const shouldRun = Boolean(process.env["RUN_LIVE_GEMINI_TESTS"] && liveKey);

  it.skipIf(!shouldRun)(
    "executes real embedding request with Google Gemini API when live key is provided",
    async () => {
      const provider: AiProvider = {
        id: "gemini",
        label: "Google Gemini",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        chatModel: "gemini-3.8-flash",
        utilityModel: "gemini-3.8-flash",
        embeddingModel: "gemini-embedding-001",
        embeddingDimensions: EMBEDDING_DIMENSIONS,
        supportsDimensionsParam: true,
        authHeaders: () => ({ "x-goog-api-key": liveKey! }),
      };

      const embeddings = await embedTexts(["Integration test sentence."], provider);
      expect(embeddings).toHaveLength(1);
      expect(embeddings[0]).toHaveLength(3072);
      expect(embeddings[0]!.every((v) => typeof v === "number" && Number.isFinite(v))).toBe(true);
    },
  );
});
