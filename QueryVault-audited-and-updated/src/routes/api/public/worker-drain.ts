/**
 * Durable ingestion drain. Called by the database scheduler (pg_cron + pg_net)
 * every minute so queued and retrying jobs make progress with no browser open.
 *
 * Auth: `x-worker-secret` — the server-only shared secret used by both the
 * Supabase scheduler and manual/operations invocations. It is intentionally
 * the only accepted mechanism, so every production caller has one audited,
 * timing-safe authorization path.
 * No PII is ever returned.
 */
import { createFileRoute } from "@tanstack/react-router";
import { constantTimeCompare } from "@/lib/constant-time-compare.server";

async function isAuthorized(request: Request): Promise<boolean> {
  const envSecret = process.env["INGESTION_WORKER_SECRET"];
  const provided = request.headers.get("x-worker-secret");
  return constantTimeCompare(provided, envSecret);
}

export const Route = createFileRoute("/api/public/worker-drain")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isAuthorized(request))) {
          return new Response("Unauthorized", { status: 401 });
        }

        const { drainIngestionJobs } = await import("@/lib/ingestion/worker.server");
        const result = await drainIngestionJobs({ maxJobs: 3 });
        return Response.json(result);
      },
    },
  },
});
