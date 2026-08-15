/**
 * Canonical event catalogue. Pure data — importable from client, server and
 * test code. The set is closed so dashboards and alerts can rely on it.
 */

export const EVENTS = {
  DOCUMENT_UPLOADED: "document.uploaded",
  DOCUMENT_VALIDATION_FAILED: "document.validation_failed",
  DOCUMENT_DELETED: "document.deleted",
  INGESTION_STARTED: "ingestion.started",
  INGESTION_COMPLETED: "ingestion.completed",
  INGESTION_FAILED: "ingestion.failed",
  INGESTION_RETRYING: "ingestion.retrying",
  RETRIEVAL_STARTED: "retrieval.started",
  RETRIEVAL_COMPLETED: "retrieval.completed",
  GENERATION_STARTED: "generation.started",
  GENERATION_COMPLETED: "generation.completed",
  GENERATION_FAILED: "generation.failed",
  QUOTA_EXCEEDED: "quota.exceeded",
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

export const EVENT_NAMES: EventName[] = Object.values(EVENTS);

export type EventStatus = "ok" | "error" | "refused" | "started" | "retrying";

/** Attribute values allowed on an event. Free-form text is deliberately excluded. */
export type AttributeValue = string | number | boolean | null;

export type TelemetryEvent = {
  event: EventName;
  requestId: string;
  status: EventStatus;
  errorCode?: string | null;
  userId?: string | null;
  documentId?: string | null;
  threadId?: string | null;
  jobId?: string | null;
  latencyMs?: number | null;
  attributes?: Record<string, AttributeValue | undefined>;
};

/**
 * Attribute keys that must never carry payload text. Anything matching is
 * dropped before the event is logged or persisted — a defence in depth on top
 * of code review, so a careless caller cannot leak document contents.
 */
export const FORBIDDEN_ATTRIBUTE_KEYS =
  /^(password|secret|api_?key|authorization|cookie|bearer|token|email|prompt|question|answer|content|body|snippet|passage|evidence|chunk)$|(_|^)(text|preview|snippet|passage|content|body|prompt|secret|password|email)$/i;

/** Values longer than this are truncated — attributes are dimensions, not blobs. */
export const MAX_ATTRIBUTE_CHARS = 120;

export function sanitizeAttributes(
  attributes: Record<string, AttributeValue | undefined> = {},
): Record<string, AttributeValue> {
  const safe: Record<string, AttributeValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) continue;
    if (FORBIDDEN_ATTRIBUTE_KEYS.test(key)) continue;
    if (typeof value === "string") {
      safe[key] = value.length > MAX_ATTRIBUTE_CHARS ? value.slice(0, MAX_ATTRIBUTE_CHARS) : value;
      continue;
    }
    if (typeof value === "number") {
      safe[key] = Number.isFinite(value) ? value : null;
      continue;
    }
    safe[key] = value;
  }
  return safe;
}
