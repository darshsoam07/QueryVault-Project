import { withDeadline } from "@/lib/async-deadline";
import { logEvent } from "@/lib/api-errors";
import { dependency } from "./contract";

export const WORKER_DEADLINES = {
  database: 15_000,
  storage: 30_000,
  parser: 60_000,
  local: 15_000,
  embedding: 75_000,
} as const;
type Identity = { id: string; document_id: string; attempt_count: number };
export function safeWorkerCode(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? code : "OPERATION_FAILED";
}
export async function workerStage<T>(
  job: Identity,
  stage: string,
  milliseconds: number,
  operation: (signal: AbortSignal) => PromiseLike<T> | T,
): Promise<T> {
  const started = performance.now();
  const fields = {
    job_id: job.id,
    document_id: job.document_id,
    attempt: job.attempt_count,
    stage,
  };
  logEvent("info", "worker.stage", job.id, { ...fields, outcome: "started" });
  try {
    const result = await withDeadline(operation, milliseconds);
    logEvent("info", "worker.stage", job.id, {
      ...fields,
      outcome: "completed",
      duration_ms: Math.round(performance.now() - started),
    });
    return result;
  } catch (error) {
    const failure =
      error instanceof Error && error.name === "TimeoutError"
        ? dependency(
            "STAGE_TIMEOUT",
            `Ingestion stage ${stage} timed out. Retrying within the attempt budget.`,
          )
        : error;
    logEvent("warn", "worker.stage", job.id, {
      ...fields,
      outcome: "failed",
      duration_ms: Math.round(performance.now() - started),
      error_code: safeWorkerCode(failure),
    });
    throw failure;
  }
}
