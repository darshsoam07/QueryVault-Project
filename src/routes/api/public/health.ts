/**
 * Health endpoint with readiness / liveness semantics.
 *
 *   GET /api/public/health            → readiness (shallow), 200 / 503
 *   GET /api/public/health?probe=live → liveness, 200 unless the app itself is broken
 *   GET /api/public/health?deep=1     → also pings the AI providers (needs worker secret)
 *
 * A dependency outage returns 503 with failure = "dependency"; an application
 * or configuration fault returns 500 with failure = "application"/"config", so
 * a load balancer and a human can tell them apart. No PII is ever returned.
 */
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/health")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { runLiveness, runReadiness } = await import("@/lib/observability/health.server");
        const url = new URL(request.url);

        if (url.searchParams.get("probe") === "live") {
          const report = await runLiveness();
          return json(report, report.status === "healthy" ? 200 : 500);
        }

        const secret = process.env["INGESTION_WORKER_SECRET"];
        const deepRequested = url.searchParams.get("deep") === "1";
        const authorized =
          Boolean(secret) && request.headers.get("x-worker-secret") === secret;
        const report = await runReadiness(deepRequested && authorized);

        if (report.status === "healthy") return json(report, 200);
        if (report.failure === "application" || report.failure === "config") {
          return json(report, 500);
        }
        return json(report, report.status === "unhealthy" ? 503 : 200);
      },
    },
  },
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
