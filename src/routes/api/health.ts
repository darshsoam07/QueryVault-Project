/**
 * GET /api/health — liveness + readiness probe. Phase 6.
 *
 * 200 { status: "ok", db: "ok", ts }     — live and DB reachable
 * 503 { status: "degraded", db: "error" } — live but DB probe failed
 *
 * Wire to Docker HEALTHCHECK or Kubernetes probes:
 *   HEALTHCHECK --interval=30s --timeout=5s \
 *     CMD curl -f http://localhost:3000/api/health || exit 1
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { createFileRoute } from "@tanstack/react-router";

const DB_PROBE_TIMEOUT_MS = 3_000;

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () => {
        const ts = new Date().toISOString();
        let dbStatus: "ok" | "error" = "error";
        let httpStatus = 503;

        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), DB_PROBE_TIMEOUT_MS);
          const { error } = await supabaseAdmin
            .rpc("health_probe" as never)
            .abortSignal(controller.signal);
          clearTimeout(timer);
          if (!error) {
            dbStatus = "ok";
            httpStatus = 200;
          }
        } catch {
          /* timeout or network failure */
        }

        return new Response(
          JSON.stringify({
            status: dbStatus === "ok" ? "ok" : "degraded",
            db: dbStatus,
            ts,
          }),
          {
            status: httpStatus,
            headers: {
              "content-type": "application/json",
              "cache-control": "no-store",
            },
          },
        );
      },
    },
  },
});
