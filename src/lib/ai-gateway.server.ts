import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export const GATEWAY_BASE_URL = "https://ai.gateway.lovable.dev/v1";

export const CHAT_MODEL = "google/gemini-3.6-flash";
export const EMBEDDING_MODEL = "google/gemini-embedding-2";
export const EMBEDDING_DIMENSIONS = 3072;

export class GatewayError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
  }
}

export function requireApiKey(): string {
  const key = process.env["LOVABLE_API_KEY"];
  if (!key) throw new GatewayError("AI is not configured for this workspace.", 500);
  return key;
}

export function createLovableAiGatewayProvider(apiKey: string) {
  return createOpenAICompatible({
    name: "lovable",
    baseURL: GATEWAY_BASE_URL,
    headers: { "Lovable-API-Key": apiKey },
  });
}

export function gatewayMessageForStatus(status: number): string {
  if (status === 429) return "Rate limit reached. Give it a few seconds and try again.";
  if (status === 402) return "AI credits are exhausted. Top up in Settings to keep asking.";
  return "The AI service failed to respond. Please try again.";
}

/** Embeds a batch of texts through the Lovable AI Gateway. */
export async function embedTexts(texts: string[], apiKey: string): Promise<number[][]> {
  if (texts.length === 0) return [];

  const response = await fetch(`${GATEWAY_BASE_URL}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Lovable-API-Key": apiKey,
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error("[gateway:embeddings] failed", response.status, detail.slice(0, 400));
    throw new GatewayError(gatewayMessageForStatus(response.status), response.status);
  }

  const payload = (await response.json()) as {
    data?: Array<{ embedding: number[]; index?: number }>;
  };
  const rows = payload.data ?? [];
  if (rows.length !== texts.length) {
    throw new GatewayError("Embedding service returned an unexpected response.", 502);
  }

  return rows
    .slice()
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((row) => row.embedding);
}

export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
