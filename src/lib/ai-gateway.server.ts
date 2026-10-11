import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import { isCreditsOrQuotaExhausted, isInvalidCredentialsError } from "@/lib/ingestion/contract";

/**
 * AI provider abstraction.
 *
 * Previously this module hard-coded a single vendor endpoint and read
 * `LOVABLE_API_KEY` from four different places. Every call site took a bare
 * `apiKey: string`, which meant the base URL, the auth header name and the
 * model names were duplicated across the reranker, the query rewriter, the
 * health probes and the chat route.
 *
 * Now there is exactly one resolution point — `requireAiProvider()` — and call
 * sites pass the resolved `AiProvider` value object instead of a raw key.
 * Swapping providers is an environment change, not a code change.
 *
 * SECURITY: the credential is deliberately NOT a plain property on
 * `AiProvider`. It is reachable only through `authHeaders()`, so the object is
 * safe to spread into a log record or `JSON.stringify` — a function is dropped
 * by the serializer rather than printed. Never add the key as a data field.
 */

/** Embedding width pinned by the database schema (`halfvec(3072)` + HNSW). */
export const EMBEDDING_DIMENSIONS = 3072;

export type AiProviderId = "openai" | "lovable" | "openai-compatible" | "gemini";

export type AiProvider = {
  id: AiProviderId;
  /** Human-readable, safe to log. */
  label: string;
  baseUrl: string;
  /** Model used for the user-facing answer. */
  chatModel: string;
  /** Cheaper model for reranking and query rewriting (runs on every query). */
  utilityModel: string;
  embeddingModel: string;
  embeddingDimensions: number;
  /**
   * Whether the embeddings endpoint honours an explicit `dimensions` request
   * field. OpenAI does; most self-hosted OpenAI-compatible servers do not and
   * reject the unknown field.
   */
  supportsDimensionsParam: boolean;
  /** Auth headers. Intentionally a function so the secret is not serializable. */
  authHeaders: () => Record<string, string>;
};

export type GatewayErrorOptions = {
  code?: string | undefined;
  errorType?: string | undefined;
  rawMessage?: string | undefined;
};

export class GatewayError extends Error {
  readonly status: number;
  readonly code?: string | undefined;
  readonly errorType?: string | undefined;
  readonly rawMessage?: string | undefined;

  constructor(message: string, status: number, options?: GatewayErrorOptions) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    if (options?.code) this.code = options.code;
    if (options?.errorType) this.errorType = options.errorType;
    if (options?.rawMessage) this.rawMessage = options.rawMessage;
  }
}

function env(name: string): string | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    const unquoted = trimmed.slice(1, -1).trim();
    return unquoted.length > 0 ? unquoted : undefined;
  }
  return trimmed;
}

function bearer(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}` };
}

type ProviderDefinition = {
  label: string;
  defaultBaseUrl: string;
  defaultChatModel: string;
  defaultUtilityModel: string;
  defaultEmbeddingModel: string;
  defaultEmbeddingDimensions: number;
  supportsDimensionsParam: boolean;
  /** Env var holding the credential. */
  keyVar: string;
  headers: (key: string) => Record<string, string>;
};

const PROVIDERS: Record<AiProviderId, ProviderDefinition> = {
  openai: {
    label: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    // text-embedding-3-large is natively 3072-dimensional, so it matches the
    // existing halfvec(3072) column with no migration.
    defaultChatModel: "gpt-4o",
    defaultUtilityModel: "gpt-4o-mini",
    defaultEmbeddingModel: "text-embedding-3-large",
    defaultEmbeddingDimensions: 3072,
    supportsDimensionsParam: true,
    keyVar: "OPENAI_API_KEY",
    headers: bearer,
  },
  gemini: {
    label: "Google Gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    // gemini-3.8-flash is official, current, and cost-efficient for chat completions.
    // gemini-embedding-001 natively outputs 3072 dimensions, matching halfvec(3072).
    defaultChatModel: "gemini-3.8-flash",
    defaultUtilityModel: "gemini-3.8-flash",
    defaultEmbeddingModel: "gemini-embedding-001",
    defaultEmbeddingDimensions: 3072,
    supportsDimensionsParam: true,
    keyVar: "GEMINI_API_KEY",
    headers: (key) => ({ "x-goog-api-key": key }),
  },
  lovable: {
    label: "Lovable AI Gateway",
    defaultBaseUrl: "https://ai.gateway.lovable.dev/v1",
    defaultChatModel: "google/gemini-3.6-flash",
    defaultUtilityModel: "google/gemini-3.6-flash",
    defaultEmbeddingModel: "google/gemini-embedding-2",
    defaultEmbeddingDimensions: 3072,
    supportsDimensionsParam: false,
    keyVar: "LOVABLE_API_KEY",
    headers: (key) => ({ "Lovable-API-Key": key }),
  },
  "openai-compatible": {
    label: "OpenAI-compatible endpoint",
    defaultBaseUrl: "",
    defaultChatModel: "",
    defaultUtilityModel: "",
    defaultEmbeddingModel: "",
    defaultEmbeddingDimensions: EMBEDDING_DIMENSIONS,
    supportsDimensionsParam: false,
    keyVar: "AI_API_KEY",
    headers: bearer,
  },
};

function resolveProviderId(): AiProviderId {
  const raw = env("AI_PROVIDER")?.toLowerCase();
  if (!raw) {
    // No explicit choice: infer from whichever credential is present so an
    // existing deployment keeps working without this setting.
    if (env("OPENAI_API_KEY")) return "openai";
    if (env("GEMINI_API_KEY")) return "gemini";
    if (env("LOVABLE_API_KEY")) return "lovable";
    return "openai";
  }
  if (raw in PROVIDERS) return raw as AiProviderId;
  throw new GatewayError(
    `Unknown AI_PROVIDER "${raw}". Expected one of: ${Object.keys(PROVIDERS).join(", ")}.`,
    500,
  );
}

/**
 * Resolves the configured provider, or throws `GatewayError` with a message
 * safe to surface to a user. Never returns a partially configured provider —
 * failing closed is preferable to embedding with the wrong model width.
 */
export function requireAiProvider(): AiProvider {
  const id = resolveProviderId();
  const def = PROVIDERS[id];

  const key = env(def.keyVar);
  if (!key) throw new GatewayError("AI is not configured for this workspace.", 500);

  const baseUrl = (
    env("AI_BASE_URL") ??
    (id === "gemini" ? env("GEMINI_BASE_URL") : undefined) ??
    (id === "openai" ? env("OPENAI_BASE_URL") : undefined) ??
    def.defaultBaseUrl
  ).replace(/\/+$/, "");

  const chatModel =
    (id === "gemini" ? env("GEMINI_CHAT_MODEL") : undefined) ??
    (id === "openai" ? env("OPENAI_CHAT_MODEL") : undefined) ??
    env("AI_CHAT_MODEL") ??
    def.defaultChatModel;

  const utilityModel =
    (id === "gemini" ? env("GEMINI_UTILITY_MODEL") : undefined) ??
    (id === "openai" ? env("OPENAI_UTILITY_MODEL") : undefined) ??
    env("AI_UTILITY_MODEL") ??
    def.defaultUtilityModel ??
    chatModel;

  const providerEmbeddingOverride =
    id === "gemini"
      ? env("GEMINI_EMBEDDING_MODEL")
      : id === "openai"
        ? env("OPENAI_EMBEDDING_MODEL")
        : undefined;

  let embeddingModel =
    providerEmbeddingOverride ?? env("AI_EMBEDDING_MODEL") ?? def.defaultEmbeddingModel;

  // Protect against cross-provider model leakage: if an OpenAI model was left in
  // generic AI_EMBEDDING_MODEL while Gemini is selected, default back to Gemini's model.
  if (
    id === "gemini" &&
    !providerEmbeddingOverride &&
    embeddingModel.startsWith("text-embedding-3")
  ) {
    embeddingModel = def.defaultEmbeddingModel;
  } else if (
    id === "openai" &&
    !providerEmbeddingOverride &&
    embeddingModel.startsWith("gemini-")
  ) {
    embeddingModel = def.defaultEmbeddingModel;
  }

  const declaredDimensions = Number(
    env("AI_EMBEDDING_DIMENSIONS") ?? def.defaultEmbeddingDimensions,
  );

  // Configuration guards. These are cheap and they prevent a whole class of
  // silent corruption: a provider whose embeddings are a different width than
  // the halfvec(3072) column would fail per-row at insert time, mid-ingestion,
  // after the parse and chunk work had already been paid for.
  if (!baseUrl) {
    throw new GatewayError(`AI_BASE_URL is required when AI_PROVIDER=${id}.`, 500);
  }
  if (!chatModel || !embeddingModel) {
    throw new GatewayError(
      `AI_CHAT_MODEL and AI_EMBEDDING_MODEL are required when AI_PROVIDER=${id}.`,
      500,
    );
  }
  if (
    id === "gemini" &&
    embeddingModel.includes("text-embedding-004") &&
    declaredDimensions > 768
  ) {
    throw new GatewayError(
      `Model "${embeddingModel}" has a maximum output dimension of 768 and cannot produce ` +
        `the ${declaredDimensions} dimensions required by the database column halfvec(${EMBEDDING_DIMENSIONS}). ` +
        `Use "gemini-embedding-001" or migrate the database schema.`,
      500,
    );
  }
  if (declaredDimensions !== EMBEDDING_DIMENSIONS) {
    throw new GatewayError(
      `Embedding width mismatch: provider is configured for ${declaredDimensions} dimensions ` +
        `but the database column is halfvec(${EMBEDDING_DIMENSIONS}). ` +
        `Choose a ${EMBEDDING_DIMENSIONS}-dimensional embedding model, or migrate the schema.`,
      500,
    );
  }

  return {
    id,
    label: def.label,
    baseUrl,
    chatModel,
    utilityModel,
    embeddingModel,
    embeddingDimensions: declaredDimensions,
    supportsDimensionsParam: def.supportsDimensionsParam,
    authHeaders: () => def.headers(key),
  };
}

/**
 * True when a credential is present, without throwing. For health probes and
 * diagnostics that need to distinguish "unconfigured" from "misconfigured".
 */
export function describeAiProvider():
  { configured: true; provider: AiProvider } | { configured: false; reason: string } {
  try {
    return { configured: true, provider: requireAiProvider() };
  } catch (error) {
    return {
      configured: false,
      reason: error instanceof GatewayError ? error.message : "AI provider is not configured.",
    };
  }
}

/** Vercel AI SDK provider for streaming chat, bound to the resolved config. */
export function createAiSdkProvider(provider: AiProvider): (modelId: string) => LanguageModel {
  if (provider.id === "gemini") {
    const key = provider.authHeaders()["x-goog-api-key"] ?? "";
    const google = createGoogleGenerativeAI({
      apiKey: key,
      baseURL: provider.baseUrl,
    });
    return (modelId: string) => google(modelId) as unknown as LanguageModel;
  }
  const compatible = createOpenAICompatible({
    name: provider.id,
    baseURL: provider.baseUrl,
    headers: provider.authHeaders(),
  });
  return (modelId: string) => compatible(modelId) as unknown as LanguageModel;
}

export type ProviderErrorDetails = {
  code?: string | undefined;
  type?: string | undefined;
  rawMessage?: string | undefined;
};

export function parseProviderErrorBody(bodyText: string): ProviderErrorDetails {
  if (!bodyText || typeof bodyText !== "string") return {};
  try {
    const parsed = JSON.parse(bodyText);
    if (!parsed || typeof parsed !== "object") return {};

    const parsedObj = parsed as Record<string, unknown>;
    const errorProp = parsedObj["error"];
    const errorObj =
      typeof errorProp === "object" && errorProp !== null
        ? (errorProp as Record<string, unknown>)
        : typeof errorProp === "string"
          ? { message: errorProp }
          : parsedObj;

    const details = Array.isArray(errorObj["details"])
      ? (errorObj["details"] as Array<Record<string, unknown>>)
      : undefined;
    const detailReason =
      typeof details?.[0]?.["reason"] === "string" ? (details[0]["reason"] as string) : undefined;
    const statusStr =
      typeof errorObj["status"] === "string" ? (errorObj["status"] as string) : undefined;

    const code =
      typeof errorObj["code"] === "string"
        ? (errorObj["code"] as string)
        : typeof errorObj["code"] === "number"
          ? String(errorObj["code"])
          : typeof parsedObj["code"] === "string"
            ? (parsedObj["code"] as string)
            : typeof parsedObj["code"] === "number"
              ? String(parsedObj["code"])
              : statusStr;

    const type =
      typeof errorObj["type"] === "string"
        ? (errorObj["type"] as string)
        : (statusStr ??
          detailReason ??
          (typeof parsedObj["type"] === "string" ? (parsedObj["type"] as string) : undefined));

    const rawMessage =
      typeof errorObj["message"] === "string"
        ? (errorObj["message"] as string)
        : typeof parsedObj["message"] === "string"
          ? (parsedObj["message"] as string)
          : undefined;

    return {
      ...(code ? { code } : {}),
      ...(type ? { type } : {}),
      ...(rawMessage ? { rawMessage } : {}),
    };
  } catch {
    return {};
  }
}

export function gatewayMessageForStatus(
  status: number,
  details?: {
    code?: string | undefined;
    type?: string | undefined;
    rawMessage?: string | undefined;
  },
): string {
  if (
    status === 402 ||
    isCreditsOrQuotaExhausted(status, details?.code, details?.type, details?.rawMessage)
  ) {
    return "The AI provider rejected the request for billing reasons: API credit balance is exhausted or quota exceeded. Please check your billing settings.";
  }
  if (
    status === 401 ||
    status === 403 ||
    isInvalidCredentialsError(status, details?.code, details?.type, details?.rawMessage)
  ) {
    // Deliberately vague to the user; the operator sees the real status in logs.
    return "The AI service rejected our credentials. An operator needs to check the configuration.";
  }
  if (status === 429) return "Rate limit reached. Give it a few seconds and try again.";
  if (status === 404)
    return "The configured AI model is unavailable. An operator needs to check it.";
  return "The AI service failed to respond. Please try again.";
}

/** Gemini chat completion via Google Generative Language REST API. */
async function chatCompletionGemini(
  provider: AiProvider,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const model =
    typeof body["model"] === "string" && body["model"] ? body["model"] : provider.utilityModel;
  const modelName = model.replace(/^models\//, "");

  const rawMessages = (Array.isArray(body["messages"]) ? body["messages"] : []) as Array<{
    role?: string;
    content?: string;
  }>;

  const systemMessages = rawMessages.filter((m) => m.role === "system");
  const systemText = systemMessages
    .map((m) => m.content ?? "")
    .filter(Boolean)
    .join("\n\n");

  const nonSystemMessages = rawMessages.filter((m) => m.role !== "system");
  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
  for (const m of nonSystemMessages) {
    const role = m.role === "assistant" ? "model" : "user";
    const text = m.content ?? "";
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      last.parts.push({ text });
    } else {
      contents.push({ role, parts: [{ text }] });
    }
  }

  const geminiBody: Record<string, unknown> = {
    contents: contents.length > 0 ? contents : [{ role: "user", parts: [{ text: "" }] }],
    generationConfig: {
      ...(typeof body["temperature"] === "number" ? { temperature: body["temperature"] } : {}),
      ...(typeof body["max_tokens"] === "number"
        ? { maxOutputTokens: body["max_tokens"] }
        : typeof body["maxTokens"] === "number"
          ? { maxOutputTokens: body["maxTokens"] }
          : {}),
    },
    ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
  };

  const response = await fetch(`${provider.baseUrl}/models/${modelName}:generateContent`, {
    method: "POST",
    ...(signal ? { signal } : {}),
    headers: { "Content-Type": "application/json", ...provider.authHeaders() },
    body: JSON.stringify(geminiBody),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const parsed = parseProviderErrorBody(detail);
    console.error("[ai:chat] failed", provider.id, response.status, detail.slice(0, 400));
    throw new GatewayError(gatewayMessageForStatus(response.status, parsed), response.status, {
      code: parsed.code,
      errorType: parsed.type,
      rawMessage: parsed.rawMessage,
    });
  }

  const payload = (await response.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string }>;
      };
    }>;
  };
  const parts = payload.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text ?? "").join("");
}

/** POSTs to the provider's chat completions endpoint. Used by rerank + rewrite. */
export async function chatCompletion(
  provider: AiProvider,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  if (provider.id === "gemini") {
    return chatCompletionGemini(provider, body, signal);
  }
  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    ...(signal ? { signal } : {}),
    headers: { "Content-Type": "application/json", ...provider.authHeaders() },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const parsed = parseProviderErrorBody(detail);
    console.error("[ai:chat] failed", provider.id, response.status, detail.slice(0, 400));
    throw new GatewayError(gatewayMessageForStatus(response.status, parsed), response.status, {
      code: parsed.code,
      errorType: parsed.type,
      rawMessage: parsed.rawMessage,
    });
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return payload.choices?.[0]?.message?.content ?? "";
}

/** Gemini batch embedding via Google Generative Language REST API. */
async function embedTextsGemini(texts: string[], provider: AiProvider): Promise<number[][]> {
  if (texts.length === 0) return [];

  const modelName = provider.embeddingModel.replace(/^models\//, "");
  if (modelName === "text-embedding-004" && provider.embeddingDimensions > 768) {
    throw new GatewayError(
      `Model "${modelName}" has a maximum output dimension of 768 and is incompatible with ` +
        `the database column halfvec(${provider.embeddingDimensions}). ` +
        `Use "gemini-embedding-001" or migrate the database schema.`,
      500,
    );
  }

  // Google Gemini batchEmbedContents endpoint accepts up to 100 requests per batch call
  const BATCH_SIZE = 100;
  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const chunk = texts.slice(i, i + BATCH_SIZE);
    const requests = chunk.map((text) => ({
      model: `models/${modelName}`,
      content: {
        parts: [{ text }],
      },
      ...(provider.supportsDimensionsParam
        ? { outputDimensionality: provider.embeddingDimensions }
        : {}),
    }));

    const response = await fetch(`${provider.baseUrl}/models/${modelName}:batchEmbedContents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...provider.authHeaders() },
      body: JSON.stringify({ requests }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const parsed = parseProviderErrorBody(detail);
      console.error("[ai:embeddings] failed", provider.id, response.status, detail.slice(0, 400));
      throw new GatewayError(gatewayMessageForStatus(response.status, parsed), response.status, {
        code: parsed.code,
        errorType: parsed.type,
        rawMessage: parsed.rawMessage,
      });
    }

    const payload = (await response.json()) as {
      embeddings?: Array<{ values?: number[] }>;
    };

    const rows = payload.embeddings ?? [];
    if (rows.length !== chunk.length) {
      throw new GatewayError("Embedding service returned an unexpected response.", 502);
    }

    for (let r = 0; r < rows.length; r++) {
      const values = rows[r]?.values;
      if (!Array.isArray(values)) {
        throw new GatewayError("Embedding service returned an invalid embedding structure.", 502);
      }
      if (values.length !== provider.embeddingDimensions) {
        throw new GatewayError(
          `Embedding model returned ${values.length} dimensions, expected ${provider.embeddingDimensions}.`,
          502,
        );
      }
      const hasNonFinite = values.some((val) => typeof val !== "number" || !Number.isFinite(val));
      if (hasNonFinite) {
        throw new GatewayError(
          "Embedding model returned non-finite numbers (NaN or Infinity).",
          502,
        );
      }
      allEmbeddings.push(values);
    }
  }

  return allEmbeddings;
}

/** Embeds a batch of texts through the configured provider. */
export async function embedTexts(texts: string[], provider: AiProvider): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (provider.id === "gemini") {
    return embedTextsGemini(texts, provider);
  }

  const response = await fetch(`${provider.baseUrl}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...provider.authHeaders() },
    body: JSON.stringify({
      model: provider.embeddingModel,
      input: texts,
      ...(provider.supportsDimensionsParam ? { dimensions: provider.embeddingDimensions } : {}),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const parsed = parseProviderErrorBody(detail);
    // Provider error bodies do not echo the credential, but they are truncated
    // anyway and never forwarded to the client.
    console.error("[ai:embeddings] failed", provider.id, response.status, detail.slice(0, 400));
    throw new GatewayError(gatewayMessageForStatus(response.status, parsed), response.status, {
      code: parsed.code,
      errorType: parsed.type,
      rawMessage: parsed.rawMessage,
    });
  }

  const payload = (await response.json()) as {
    data?: Array<{ embedding: number[]; index?: number }>;
  };
  const rows = payload.data ?? [];
  if (rows.length !== texts.length) {
    throw new GatewayError("Embedding service returned an unexpected response.", 502);
  }

  const ordered = rows
    .slice()
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((row) => row.embedding);

  // Guard the schema invariant at the boundary rather than at INSERT time.
  const wrong = ordered.find((embedding) => embedding.length !== provider.embeddingDimensions);
  if (wrong) {
    throw new GatewayError(
      `Embedding model returned ${wrong.length} dimensions, expected ${provider.embeddingDimensions}.`,
      502,
    );
  }

  const nonFinite = ordered.find((embedding) =>
    embedding.some((val) => typeof val !== "number" || !Number.isFinite(val)),
  );
  if (nonFinite) {
    throw new GatewayError("Embedding model returned non-finite numbers (NaN or Infinity).", 502);
  }

  return ordered;
}

export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
