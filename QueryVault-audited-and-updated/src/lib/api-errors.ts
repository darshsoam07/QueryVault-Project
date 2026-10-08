/**
 * Typed API error model + request correlation IDs.
 *
 * Every server surface returns the same JSON envelope:
 *   { error: { code, message, request_id } }
 * Internal exception text is never forwarded to clients.
 */

export const ERROR_CODES = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  INVALID_REQUEST: 400,
  THREAD_NOT_FOUND: 404,
  DOCUMENT_NOT_FOUND: 404,
  DOCUMENT_NOT_READY: 409,
  DOCUMENT_DUPLICATE: 409,
  DOCUMENT_INVALID: 422,
  DOCUMENT_TOO_LARGE: 413,
  ILLEGAL_STATE_TRANSITION: 409,
  RATE_LIMITED: 429,
  RATE_LIMIT_UNAVAILABLE: 503,
  AI_UNAVAILABLE: 503,
  NOT_CONFIGURED: 500,
  INTERNAL: 500,
} as const;

export type ApiErrorCode = keyof typeof ERROR_CODES;

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;

  constructor(code: ApiErrorCode, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = ERROR_CODES[code];
  }
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Correlation ID shaped like `qv_<24 chars>`. */
export function newRequestId(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let out = "qv_";
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

export type ErrorBody = {
  error: { code: ApiErrorCode; message: string; request_id: string };
};

export function errorBody(code: ApiErrorCode, message: string, requestId: string): ErrorBody {
  return { error: { code, message, request_id: requestId } };
}

export function errorResponse(
  error: unknown,
  requestId: string,
  extraHeaders: Record<string, string> = {},
): Response {
  const apiError =
    error instanceof ApiError
      ? error
      : new ApiError("INTERNAL", "Something went wrong. Please try again.");

  return new Response(JSON.stringify(errorBody(apiError.code, apiError.message, requestId)), {
    status: apiError.status,
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId,
      ...extraHeaders,
    },
  });
}

type LogFields = Record<string, string | number | boolean | null | undefined>;

const REDACTED_KEYS = /pass|token|key|secret|authorization|content|prompt|snippet|question/i;

/**
 * Structured, redaction-safe logging. Never pass document text, prompts,
 * credentials or tokens — such keys are dropped defensively.
 */
export function logEvent(
  level: "info" | "warn" | "error",
  event: string,
  requestId: string,
  fields: LogFields = {},
): void {
  const safe: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (REDACTED_KEYS.test(key)) continue;
    safe[key] = value;
  }
  const line = JSON.stringify({ level, event, request_id: requestId, ...safe });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}
