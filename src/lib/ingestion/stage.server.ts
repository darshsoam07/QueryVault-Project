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
export function schemaErrorKind(code: string): string | undefined {
  return (
    {
      PGRST202: "function_not_resolved",
      PGRST203: "ambiguous_function",
      "42883": "undefined_function",
      "42703": "undefined_column",
    } as Record<string, string>
  )[code];
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
    // Supabase resolves HTTP/database errors as { data, error }; a resolved
    // promise is not a successful operation. Return it for caller-specific
    // classification/fallback, but never log it as completed.
    const responseError =
      result && typeof result === "object" && "error" in result ? result.error : null;
    if (responseError) {
      const code = safeWorkerCode(responseError);
      logEvent("warn", "worker.stage", job.id, {
        ...fields,
        outcome: "failed",
        duration_ms: Math.round(performance.now() - started),
        error_code: code,
        ...(schemaErrorKind(code) ? { schema_error_kind: schemaErrorKind(code) } : {}),
      });
      return result;
    }
    logEvent("info", "worker.stage", job.id, {
      ...fields,
      outcome:
        result && typeof result === "object" && "data" in result && result.data === false
          ? "rejected"
          : "completed",
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
