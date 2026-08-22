/**
 * Client error reporting.
 *
 * This replaces `lovable-error-reporting.ts`, which forwarded boundary errors to
 * `window.__lovableEvents` and `window.__lovableReportRuntimeError`. Those hooks
 * are injected only by the Lovable editor preview, so in a real deployment the
 * root error boundary reported nowhere at all: a white screen produced no
 * console output, no log line and no telemetry.
 *
 * The replacement has two sinks, both of which work in production:
 *
 *  1. The browser console — immediate, zero infrastructure, survives a failed
 *     network call.
 *  2. `POST /api/client-errors` — persists a `client.error` telemetry event so
 *     crashes are visible in `observability_summary()` alongside server errors.
 *
 * The server sink requires an authenticated session. That is deliberate: an
 * unauthenticated ingest endpoint is a spam vector, and a signed-in user is
 * rate-limitable by user id. Errors thrown before sign-in still reach the
 * console, and the boundary still renders.
 *
 * Reporting is strictly best effort. It never throws, never blocks the boundary
 * from rendering, and never retries.
 */
import { supabase } from "@/integrations/supabase/client";

/** Stack traces can be enormous; the server truncates further before storing. */
const MAX_STACK_CHARS = 4000;
const MAX_MESSAGE_CHARS = 500;

export type ErrorContext = {
  /** Which boundary or handler caught this. */
  boundary?: string;
  [key: string]: string | number | boolean | null | undefined;
};

/**
 * Loaders and server functions commonly throw a raw `Response`, whose
 * `String()` form is the useless "[object Response]". Pull out something
 * diagnosable instead.
 */
function describe(error: unknown): { message: string; stack?: string } {
  if (error instanceof Response) {
    return { message: `Response ${error.status}${error.url ? ` at ${error.url}` : ""}` };
  }
  if (error instanceof Error) {
    return {
      message: error.message || error.name,
      ...(error.stack ? { stack: error.stack.slice(0, MAX_STACK_CHARS) } : {}),
    };
  }
  if (typeof error === "string") return { message: error };
  try {
    return { message: JSON.stringify(error).slice(0, MAX_MESSAGE_CHARS) };
  } catch {
    return { message: String(error) };
  }
}

/** Fire-and-forget POST. `keepalive` lets it survive an immediate navigation. */
async function send(payload: Record<string, unknown>): Promise<void> {
  // No session means no rate-limit key, so we do not offer the endpoint an
  // anonymous write. The console sink already fired.
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return;

  await fetch("/api/client-errors", {
    method: "POST",
    keepalive: true,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
}

/**
 * Reports an unhandled client error. Safe to call from a React error boundary,
 * a `window.onerror` handler or an `unhandledrejection` handler.
 */
export function reportClientError(error: unknown, context: ErrorContext = {}): void {
  if (typeof window === "undefined") return;

  const { message, stack } = describe(error);
  const route = window.location.pathname;

  // Sink 1: always, and first, so a failing network does not lose the error.
  console.error("[queryvault] unhandled client error", { message, route, ...context, stack });

  // Sink 2: best effort. Swallow every failure — a reporting outage must not
  // turn into a second error inside the error boundary.
  void send({
    message: message.slice(0, MAX_MESSAGE_CHARS),
    ...(stack ? { stack } : {}),
    route,
    boundary: context.boundary ?? "unknown",
    userAgent: navigator.userAgent.slice(0, 200),
  }).catch(() => {
    /* reporting is not worth a second failure */
  });
}
