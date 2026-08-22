/**
 * Client-side error normalisation.
 *
 * The server surfaces (API routes and `createServerFn` handlers) already return
 * curated `ApiError` messages — see `src/lib/api-errors.ts`. But components also
 * query Supabase directly through the browser client, and those calls return raw
 * PostgREST/Postgres errors. Passing `error.message` from one of those into a
 * toast leaks database internals to the user: table names, column names,
 * constraint names, and RLS policy hints that describe the schema.
 *
 * So this module does two things:
 *
 *  1. `fromQueryError` converts a Supabase query error into a `ClientError`
 *     carrying a curated, code-tagged message. The raw provider text goes to the
 *     developer console only. Use it at every direct-query site.
 *  2. `userMessage` is the last line of defence for a `toast.error` handler: if
 *     an un-curated database error ever reaches it, it substitutes a safe
 *     message instead of rendering the raw text.
 *
 * Never widen this to echo `error.message` from an unrecognised source.
 */

/** Shape of a Supabase/PostgREST error, structurally matched (no runtime import). */
type QueryErrorLike = {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
};

export class ClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ClientError";
    this.code = code;
  }
}

/**
 * Postgres SQLSTATE + PostgREST codes mapped to text a user can act on.
 * Anything absent here is deliberately generic — an unmapped code means we have
 * not decided what it means to a user, and guessing would leak the raw string.
 */
const CODE_MESSAGES: Record<string, { code: string; message: string }> = {
  // --- PostgREST ---------------------------------------------------------
  PGRST116: { code: "NOT_FOUND", message: "That item no longer exists." },
  PGRST202: {
    code: "NOT_CONFIGURED",
    message: "This workspace is not fully set up yet. An operator needs to finish configuration.",
  },
  PGRST205: {
    code: "NOT_CONFIGURED",
    message: "This workspace is not fully set up yet. An operator needs to finish configuration.",
  },
  PGRST301: {
    code: "SESSION_EXPIRED",
    message: "Your session expired. Sign in again to continue.",
  },
  // --- Postgres SQLSTATE -------------------------------------------------
  // 42501 is what a Row Level Security denial looks like from the client. The
  // user is authenticated but not authorised for this row, and the raw message
  // names the policy and table — never show it.
  "42501": { code: "FORBIDDEN", message: "You do not have access to that." },
  "23505": { code: "DUPLICATE", message: "That already exists." },
  "23503": { code: "INVALID_REFERENCE", message: "That item references something unavailable." },
  "23514": { code: "INVALID_REQUEST", message: "That request was rejected as invalid." },
  "23502": {
    code: "INVALID_REQUEST",
    message: "Something required was missing from that request.",
  },
  "22P02": { code: "INVALID_REQUEST", message: "That identifier is not valid." },
  "40001": { code: "CONFLICT", message: "That conflicted with another change. Try again." },
  "57014": { code: "TIMEOUT", message: "That took too long. Try again." },
  "53300": { code: "UNAVAILABLE", message: "The service is busy. Try again in a moment." },
  "08006": { code: "UNAVAILABLE", message: "Lost connection to the service. Try again." },
  "08003": { code: "UNAVAILABLE", message: "Lost connection to the service. Try again." },
};

/** True when `value` looks like a raw PostgREST/Postgres error rather than ours. */
function isQueryErrorLike(value: unknown): value is QueryErrorLike {
  if (typeof value !== "object" || value === null) return false;
  if (value instanceof ClientError) return false;
  const candidate = value as Record<string, unknown>;
  // PostgrestError always carries `message`, plus `details`/`hint` fields that
  // an ApiError never has. `code` alone is not enough to tell them apart.
  return (
    typeof candidate["message"] === "string" &&
    ("details" in candidate || "hint" in candidate) &&
    !(value instanceof Error && candidate["name"] === "ApiError")
  );
}

/**
 * Converts a Supabase query error into a curated `ClientError`.
 *
 * `fallback` describes the failed operation in product language, e.g.
 * "Could not load your conversations." It is used whenever the underlying code
 * is unmapped, so the user always gets an actionable sentence.
 */
export function fromQueryError(error: unknown, fallback: string): ClientError {
  const raw = isQueryErrorLike(error) ? error : null;
  const code = typeof raw?.code === "string" ? raw.code : null;

  // Developer-facing only. This is the browser console, not the product UI, and
  // it never contains credentials — Supabase errors describe schema, not secrets.
  if (import.meta.env.DEV) {
    console.error("[supabase] query failed", {
      code,
      message: raw?.message ?? String(error),
      details: raw?.details,
      hint: raw?.hint,
    });
  }

  const mapped = code ? CODE_MESSAGES[code] : undefined;
  if (mapped) return new ClientError(mapped.code, mapped.message);
  return new ClientError(code ?? "INTERNAL", fallback);
}

/**
 * Extracts the curated message from our standard API error envelope,
 * `{ error: { code, message, request_id } }`.
 *
 * Needed because some clients — notably the AI SDK's `useChat` — surface a
 * non-2xx response by putting the raw body text into `Error.message`. Without
 * this, the chat panel renders a JSON blob at the user.
 */
export function parseApiEnvelope(
  text: string,
): { code: string; message: string; requestId?: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as {
      error?: { code?: unknown; message?: unknown; request_id?: unknown };
    };
    const envelope = parsed.error;
    if (!envelope || typeof envelope.message !== "string") return null;
    return {
      code: typeof envelope.code === "string" ? envelope.code : "INTERNAL",
      message: envelope.message,
      ...(typeof envelope.request_id === "string" ? { requestId: envelope.request_id } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Message safe to render for any caught error.
 *
 * `ClientError` and `Error` (which, from our server functions, always carries an
 * `ApiError` message) pass through. A raw database error is replaced by
 * `fallback` — that substitution is the point of this function.
 */
export function userMessage(error: unknown, fallback: string): string {
  if (error instanceof ClientError) return error.message;
  if (isQueryErrorLike(error)) return fromQueryError(error, fallback).message;
  if (error instanceof Error && error.message.trim().length > 0) {
    return parseApiEnvelope(error.message)?.message ?? error.message;
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return parseApiEnvelope(error)?.message ?? error;
  }
  return fallback;
}
