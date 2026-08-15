/**
 * Pure ingestion contract: pipeline versions, phases, failure taxonomy,
 * retry policy and deterministic chunk identity.
 *
 * Everything here is side-effect free so the worker's decisions can be tested
 * without a database, storage or a model.
 */

/** Bump when PDF text extraction changes in a way that alters output. */
export const PARSER_VERSION = 1;
/** Bump when chunk boundaries change. Vectors from other versions are pruned. */
export const CHUNKER_VERSION = 2;
/** Identifies the code that ran a job; recorded on every attempt. */
export const WORKER_VERSION = "ingest-worker@3";

export const CHUNK_SIZE = 1000;
export const CHUNK_OVERLAP = 200;
export const EMBED_BATCH = 24;

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

/** Anything unrecognised is treated as transient — but bounded by max attempts. */
export function classifyError(error: unknown): IngestionFailure {
  if (error instanceof IngestionFailure) return error;
  const message = error instanceof Error ? error.message : "Ingestion failed.";
  const status = (error as { status?: number } | null)?.status;
  if (typeof status === "number") {
    if (status === 429) return resourceLimit("RATE_LIMITED", message);
    if (status === 402) return resourceLimit("CREDITS_EXHAUSTED", message);
    if (status >= 500) return dependency("UPSTREAM_ERROR", message);
    if (status >= 400) return permanent("UPSTREAM_REJECTED", message);
  }
  if (/timed? ?out|network|fetch failed|socket/i.test(message)) {
    return dependency("UPSTREAM_TIMEOUT", message);
  }
  return transient("UNEXPECTED", message);
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
