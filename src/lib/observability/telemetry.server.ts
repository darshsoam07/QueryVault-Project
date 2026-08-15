/**
 * Telemetry sink. Every event is (1) written to stdout as a structured line so
 * it lands in platform logs, and (2) persisted to `telemetry_events` for the
 * operator dashboard. Persistence is best-effort and never blocks a request.
 *
 * Secrets, prompts, document text and full answers never reach this module —
 * `sanitizeAttributes` drops such keys defensively.
 */
import { logEvent } from "@/lib/api-errors";
import { sanitizeAttributes, type EventStatus, type TelemetryEvent } from "./events";

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

function level(status: EventStatus): "info" | "warn" | "error" {
  if (status === "error") return "error";
  if (status === "refused") return "warn";
  return "info";
}

/** Emits one structured event. Awaiting is optional; failures are swallowed. */
export async function emit(event: TelemetryEvent): Promise<void> {
  const attributes = sanitizeAttributes(event.attributes);

  logEvent(level(event.status), event.event, event.requestId, {
    status: event.status,
    error_code: event.errorCode ?? null,
    user_id: event.userId ?? null,
    document_id: event.documentId ?? null,
    thread_id: event.threadId ?? null,
    job_id: event.jobId ?? null,
    latency_ms: event.latencyMs ?? null,
    ...attributes,
  });

  try {
    const db = await admin();
    await db.from("telemetry_events").insert({
      request_id: event.requestId,
      event: event.event,
      status: event.status,
      error_code: event.errorCode ?? null,
      user_id: event.userId ?? null,
      document_id: event.documentId ?? null,
      thread_id: event.threadId ?? null,
      job_id: event.jobId ?? null,
      latency_ms: event.latencyMs ?? null,
      attributes,
    });
  } catch {
    // Observability must never break the operation it is observing.
  }
}

/** Fire-and-forget variant for hot paths. */
export function emitAsync(event: TelemetryEvent): void {
  void emit(event).catch(() => undefined);
}

export type TraceStage = {
  name: string;
  latencyMs: number | null;
  count: number | null;
  detail?: Record<string, string | number | boolean | null>;
};

export type QueryTraceInput = {
  requestId: string;
  userId: string;
  threadId: string | null;
  question: string;
  answerPreview: string | null;
  grounded: boolean;
  refused: boolean;
  gateReason: string | null;
  reranker: string | null;
  stages: Record<string, unknown>;
  citations: string[];
  retrievalLatencyMs: number | null;
  generationLatencyMs: number | null;
  totalLatencyMs: number | null;
};

/**
 * Persists the full pipeline breakdown for one question. Visible to the owner
 * and to operators only (RLS), and used exclusively by the debug view.
 * The answer is stored truncated; document passages are stored as ids, scores
 * and short previews produced by the pipeline, never as full chunk text.
 */
export async function recordQueryTrace(trace: QueryTraceInput): Promise<void> {
  try {
    const db = await admin();
    await db.from("query_traces").insert({
      request_id: trace.requestId,
      user_id: trace.userId,
      thread_id: trace.threadId,
      question: trace.question.slice(0, 4000),
      answer_preview: trace.answerPreview ? trace.answerPreview.slice(0, 2000) : null,
      grounded: trace.grounded,
      refused: trace.refused,
      gate_reason: trace.gateReason,
      reranker: trace.reranker,
      stages: JSON.parse(JSON.stringify(trace.stages)),
      citations: trace.citations,
      retrieval_latency_ms: trace.retrievalLatencyMs,
      generation_latency_ms: trace.generationLatencyMs,
      total_latency_ms: trace.totalLatencyMs,
    });
  } catch {
    // Tracing is diagnostic only.
  }
}
