/**
 * Pure ingestion contract: pipeline versions, phases, failure taxonomy,
 * retry policy and deterministic chunk identity.
 *
 * Everything here is side-effect free so the worker's decisions can be tested
 * without a database, storage or a model.
 */

/** Bump when document extraction or authentic locator ordering changes in a way that alters output. */
export const PARSER_VERSION = 2;
/** Bump when chunk boundaries change. Vectors from other versions are pruned. */
export const CHUNKER_VERSION = 3;
/** Identifies the code that ran a job; recorded on every attempt. */
export const WORKER_VERSION = "ingest-worker@4";

export type ChunkMetadata = {
  section?: string | undefined;
  breadcrumbs?: string[] | undefined;
  isTable?: boolean | undefined;
  pageNumber: number;
};

export const CHUNK_SIZE = 1000;
export const CHUNK_OVERLAP = 200;
export const EMBED_BATCH = 24;

/**
 * Embedding vector size. Must match the Postgres column definition.
 * Override via VITE_EMBED_DIMENSIONS (build-time) when switching models.
 */
export const EMBED_DIMENSIONS: number = (() => {
  const raw =
    (typeof process !== "undefined" && process.env["VITE_EMBED_DIMENSIONS"]) ??
    (typeof import.meta !== "undefined" &&
    (import.meta as unknown as Record<string, unknown>)["env"]
      ? (import.meta as unknown as { env: Record<string, string> }).env["VITE_EMBED_DIMENSIONS"]
      : undefined);
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3072;
})();

/** Mime types that are natively supported by the chunking pipeline. */
export const SUPPORTED_MIME_TYPES = [
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;

/**
 * Phase 3: documents with fewer than this many chars per page are likely
 * scan-only PDFs (no text layer). The worker flags these with
 * metadata.ocr_suspect = true so the UI can warn the user.
 */
export const OCR_SUSPECT_CHARS_PER_PAGE = 100;

/** Server-reported phases. The UI renders these verbatim — never invented. */
export const INGESTION_PHASES = [
  "uploading",
  "queued",
  "validating",
  "parsing",
  "chunking",
  "embedding",
  "indexing",
  "ready",
  "failed",
  "deleting",
] as const;

export type IngestionPhase = (typeof INGESTION_PHASES)[number];

/** Ordered work phases, used for honest phase-based progress (no fake %). */
export const PHASE_SEQUENCE: IngestionPhase[] = [
  "uploading",
  "queued",
  "validating",
  "parsing",
  "chunking",
  "embedding",
  "indexing",
  "ready",
];

export const PHASE_LABELS: Record<IngestionPhase, string> = {
  uploading: "Uploading",
  queued: "Queued",
  validating: "Validating",
  parsing: "Parsing",
  chunking: "Chunking",
  embedding: "Embedding",
  indexing: "Indexing",
  ready: "Ready",
  failed: "Failed",
  deleting: "Removing",
};

/** Step N of M, for a determinate but non-fabricated progress bar. */
export function phaseProgress(phase: IngestionPhase): { step: number; total: number } {
  const total = PHASE_SEQUENCE.length;
  const index = PHASE_SEQUENCE.indexOf(phase);
  return { step: index < 0 ? 0 : index + 1, total };
}

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "retrying";

/* --------------------------------- errors -------------------------------- */

export type FailureClass = "TRANSIENT" | "PERMANENT" | "DEPENDENCY" | "RESOURCE_LIMIT";

export class IngestionFailure extends Error {
  readonly failureClass: FailureClass;
  readonly code: string;

  constructor(failureClass: FailureClass, code: string, message: string) {
    super(message);
    this.name = "IngestionFailure";
    this.failureClass = failureClass;
    this.code = code;
  }
}

export const permanent = (code: string, message: string) =>
  new IngestionFailure("PERMANENT", code, message);
export const transient = (code: string, message: string) =>
  new IngestionFailure("TRANSIENT", code, message);
export const dependency = (code: string, message: string) =>
  new IngestionFailure("DEPENDENCY", code, message);
export const resourceLimit = (code: string, message: string) =>
  new IngestionFailure("RESOURCE_LIMIT", code, message);

export function isCreditsOrQuotaExhausted(
  status?: number,
  code?: string,
  type?: string,
  message?: string,
): boolean {
  if (status === 402) return true;
  const normalizedCode = code?.toLowerCase().trim() ?? "";
  const normalizedType = type?.toLowerCase().trim() ?? "";
  if (
    normalizedCode === "credit_balance_exhausted" ||
    normalizedCode === "insufficient_quota" ||
    normalizedCode === "billing_not_active" ||
    normalizedCode === "account_deactivated" ||
    normalizedCode === "quota_exceeded"
  ) {
    return true;
  }
  if (
    normalizedType === "insufficient_quota" ||
    normalizedType === "credit_balance_exhausted" ||
    normalizedType === "billing_error"
  ) {
    return true;
  }
  const text = `${message ?? ""} ${code ?? ""} ${type ?? ""}`.toLowerCase();
  if (
    text.includes("insufficient_quota") ||
    text.includes("credit_balance_exhausted") ||
    text.includes("credit balance") ||
    text.includes("exceeded your current quota") ||
    text.includes("check your plan and billing") ||
    text.includes("billing reasons") ||
    text.includes("quota exceeded") ||
    text.includes("quota limit reached") ||
    text.includes("daily quota") ||
    text.includes("billing is not enabled") ||
    text.includes("billing not enabled")
  ) {
    return true;
  }
  return false;
}

export function isInvalidCredentialsError(
  status?: number,
  code?: string,
  type?: string,
  message?: string,
): boolean {
  if (status === 401 || status === 403) return true;
  const normalizedCode = code?.toLowerCase().trim() ?? "";
  const normalizedType = type?.toLowerCase().trim() ?? "";
  if (
    normalizedCode === "invalid_api_key" ||
    normalizedCode === "unauthorized" ||
    normalizedCode === "forbidden" ||
    normalizedCode === "authentication_error" ||
    normalizedCode === "permission_denied" ||
    normalizedCode === "api_key_invalid"
  ) {
    return true;
  }
  if (
    normalizedType === "authentication_error" ||
    normalizedType === "permission_denied" ||
    normalizedType === "api_key_invalid"
  ) {
    return true;
  }
  const text = `${message ?? ""} ${code ?? ""} ${type ?? ""}`.toLowerCase();
  if (
    text.includes("invalid api key") ||
    text.includes("incorrect api key") ||
    text.includes("rejected our credentials") ||
    text.includes("invalid_api_key") ||
    text.includes("unauthorized") ||
    text.includes("api key not valid") ||
    text.includes("api_key_invalid") ||
    text.includes("unregistered callers")
  ) {
    return true;
  }
  return false;
}

/** Anything unrecognised is treated as transient — but bounded by max attempts. */
export function classifyError(error: unknown): IngestionFailure {
  if (error instanceof IngestionFailure) return error;

  const candidate =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const status = typeof candidate["status"] === "number" ? candidate["status"] : undefined;

  const details =
    typeof candidate["details"] === "object" && candidate["details"] !== null
      ? (candidate["details"] as Record<string, unknown>)
      : undefined;

  const rawCode =
    typeof candidate["code"] === "string"
      ? candidate["code"]
      : typeof details?.["code"] === "string"
        ? (details["code"] as string)
        : undefined;

  const rawType =
    typeof candidate["errorType"] === "string"
      ? candidate["errorType"]
      : typeof candidate["type"] === "string"
        ? candidate["type"]
        : typeof details?.["type"] === "string"
          ? (details["type"] as string)
          : undefined;

  const rawMsg =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : typeof candidate["message"] === "string"
          ? candidate["message"]
          : "Ingestion failed.";

  if (rawCode === "ZERO_COST_AI_BLOCKED")
    return permanent(
      "AI_DISABLED",
      "AI requests are disabled in the local-only zero-cost profile. No embedding request was sent.",
    );

  // 1. Quota / Credits exhausted (permanent, terminal failure state, NO exponential backoff)
  if (isCreditsOrQuotaExhausted(status, rawCode, rawType, rawMsg)) {
    const userMsg =
      rawMsg && !/^(ingestion failed\.?|error|no credits)$/i.test(rawMsg)
        ? rawMsg
        : "The AI provider rejected the request for billing reasons: API credit balance is exhausted or quota exceeded. Please check your billing settings.";
    return permanent("CREDITS_EXHAUSTED", userMsg);
  }

  // 2. Invalid credentials (permanent, terminal failure state, NO exponential backoff)
  if (isInvalidCredentialsError(status, rawCode, rawType, rawMsg)) {
    const userMsg =
      rawMsg && !/^(ingestion failed\.?|error)$/i.test(rawMsg)
        ? rawMsg
        : "The AI service rejected our credentials. An operator needs to check the configuration.";
    return permanent("INVALID_CREDENTIALS", userMsg);
  }

  // 3. Genuine request/token rate limits (resource limit, retryable with exponential backoff)
  if (
    status === 429 ||
    rawCode === "rate_limit_exceeded" ||
    rawType === "requests" ||
    rawType === "tokens" ||
    rawType === "resource_exhausted" ||
    rawCode === "resource_exhausted"
  ) {
    return resourceLimit("RATE_LIMITED", rawMsg);
  }

  // 4. Upstream HTTP status codes
  if (typeof status === "number") {
    if (status >= 500) return dependency("UPSTREAM_ERROR", rawMsg);
    if (status >= 400) return permanent("UPSTREAM_REJECTED", rawMsg);
  }

  // 5. Network timeouts and socket dropouts
  if (/timed? ?out|network|fetch failed|socket|econnreset|econnrefused/i.test(rawMsg)) {
    return dependency("UPSTREAM_TIMEOUT", rawMsg);
  }

  // 6. Permanent dimension or schema mismatches
  if (/dimensions?, expected|width mismatch/i.test(rawMsg)) {
    return permanent("UPSTREAM_REJECTED", rawMsg);
  }

  return transient("UNEXPECTED", rawMsg);
}

export const MAX_ATTEMPTS = 4;

export function isRetryable(failure: IngestionFailure, attemptCount: number): boolean {
  if (failure.failureClass === "PERMANENT") return false;
  return attemptCount < MAX_ATTEMPTS;
}

/** Bounded exponential backoff with jitter; resource limits back off harder. */
export function backoffSeconds(attemptCount: number, failureClass: FailureClass): number {
  const base = failureClass === "RESOURCE_LIMIT" ? 30 : 5;
  const raw = base * Math.pow(2, Math.max(0, attemptCount - 1));
  const capped = Math.min(raw, 600);
  const jitter = Math.round(capped * 0.2 * Math.random());
  return capped + jitter;
}

/* ------------------------------- identity -------------------------------- */

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Deterministic chunk UUID: the same document + pipeline version + position
 * always yields the same id, so re-running a job upserts instead of duplicating.
 */
export async function deterministicChunkId(
  documentId: string,
  chunkingVersion: number,
  chunkIndex: number,
): Promise<string> {
  const seed = `${documentId}:v${chunkingVersion}:${chunkIndex}`;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)),
  );
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5 (name-based)
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const value = hex(bytes);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
