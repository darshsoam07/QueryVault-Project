/**
 * Client error ingest.
 *
 * Receives unhandled browser errors from `reportClientError` and records them as
 * `client.error` telemetry, so a crashed render is visible next to server-side
 * failures instead of vanishing into the user's console.
 *
 * Hardening notes:
 *  - Authentication is required. This is not an open ingest endpoint; the bearer
 *    token both identifies the reporter and gives the limiter a key.
 *  - Rate limited per user, so a component stuck in a crash loop cannot flood
 *    the table.
 *  - The stack trace goes to the server log only. Telemetry attributes hold the
 *    truncated message and the route, and `sanitizeAttributes` drops anything
 *    matching the forbidden-key patterns.
 *  - Always answers 202. A reporting endpoint that returns errors invites the
 *    client to retry a failing report, and the browser has nothing useful to do
 *    with the response either way.
 */
import { ApiError, logEvent, newRequestId } from "@/lib/api-errors";
import { EVENTS } from "@/lib/observability/events";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const ReportInput = z.object({
  message: z.string().min(1).max(500),
  stack: z.string().max(4000).optional(),
  route: z.string().max(300).optional(),
  boundary: z.string().max(120).optional(),
  userAgent: z.string().max(200).optional(),
});

const ACCEPTED = new Response(null, { status: 202 });

export const Route = createFileRoute("/api/client-errors")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const requestId = request.headers.get("x-request-id") ?? newRequestId();

        try {
          const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
          if (!token) throw new ApiError("UNAUTHENTICATED", "Sign in required.");

          const { userIdFromToken } = await import("@/integrations/supabase/verify-token.server");
          const userId = await userIdFromToken(token);
          if (!userId) throw new ApiError("UNAUTHENTICATED", "Session expired.");

          const { enforceRateLimit } = await import("@/lib/rate-limit.server");
          await enforceRateLimit(userId, "client_error");

          const parsed = ReportInput.safeParse(await request.json());
          if (!parsed.success) throw new ApiError("INVALID_REQUEST", "Malformed report.");
          const report = parsed.data;

          // Full stack to the server log; only dimensions to telemetry.
          logEvent("error", "client.unhandled_error", requestId, {
            user_id: userId,
            route: report.route ?? null,
            boundary: report.boundary ?? null,
            detail: report.message,
            stack: report.stack ?? null,
            user_agent: report.userAgent ?? null,
          });

          const { emitAsync } = await import("@/lib/observability/telemetry.server");
          emitAsync({
            event: EVENTS.CLIENT_ERROR,
            requestId,
            status: "error",
            errorCode: "CLIENT_EXCEPTION",
            userId,
            attributes: {
              route: report.route ?? null,
              boundary: report.boundary ?? null,
              detail: report.message,
            },
          });

          return ACCEPTED;
        } catch (error) {
          // Deliberately swallowed: see the note above about not inviting
          // retries. Operators still see the reason here.
          logEvent("warn", "client_errors.rejected", requestId, {
            reason: error instanceof ApiError ? error.code : "unknown",
          });
          return ACCEPTED;
        }
      },
    },
  },
});
