import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

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

export type AiProviderId = "openai" | "lovable" | "openai-compatible";

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

export class GatewayError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
  }
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : undefined;
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
    // existing Lovable-only deployment keeps working after this refactor.
    if (env("OPENAI_API_KEY")) return "openai";
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

  const baseUrl = (env("AI_BASE_URL") ?? env("OPENAI_BASE_URL") ?? def.defaultBaseUrl).replace(
    /\/+$/,
    "",
  );
  const chatModel = env("AI_CHAT_MODEL") ?? def.defaultChatModel;
  const utilityModel = env("AI_UTILITY_MODEL") ?? def.defaultUtilityModel ?? chatModel;
  const embeddingModel = env("AI_EMBEDDING_MODEL") ?? def.defaultEmbeddingModel;

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
export function createAiSdkProvider(provider: AiProvider) {
  return createOpenAICompatible({
    name: provider.id,
    baseURL: provider.baseUrl,
    headers: provider.authHeaders(),
  });
}

export function gatewayMessageForStatus(status: number): string {
  if (status === 429) return "Rate limit reached. Give it a few seconds and try again.";
  if (status === 401 || status === 403) {
    // Deliberately vague to the user; the operator sees the real status in logs.
    return "The AI service rejected our credentials. An operator needs to check the configuration.";
  }
  if (status === 402) return "The AI provider rejected the request for billing reasons.";
  if (status === 404)
    return "The configured AI model is unavailable. An operator needs to check it.";
  return "The AI service failed to respond. Please try again.";
}

/** POSTs to the provider's chat completions endpoint. Used by rerank + rewrite. */
export async function chatCompletion(
  provider: AiProvider,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    ...(signal ? { signal } : {}),
    headers: { "Content-Type": "application/json", ...provider.authHeaders() },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new GatewayError(gatewayMessageForStatus(response.status), response.status);
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return payload.choices?.[0]?.message?.content ?? "";
}

/** Embeds a batch of texts through the configured provider. */
export async function embedTexts(texts: string[], provider: AiProvider): Promise<number[][]> {
  if (texts.length === 0) return [];

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
    // Provider error bodies do not echo the credential, but they are truncated
    // anyway and never forwarded to the client.
    console.error("[ai:embeddings] failed", provider.id, response.status, detail.slice(0, 400));
    throw new GatewayError(gatewayMessageForStatus(response.status), response.status);
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

  return ordered;
}

export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
