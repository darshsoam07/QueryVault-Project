/**
 * Dedicated Ingestion Worker Process.
 *
 * Runs continuously in the background to drain ingestion jobs from the queue
 * with bounded concurrency and configurable polling backoff.
 *
 * Usage:
 *   npm run worker
 */
import { drainIngestionJobs } from "../src/lib/ingestion/worker.server";

const DEFAULT_POLL_INTERVAL_MS = 2000;
const MAX_IDLE_INTERVAL_MS = 5000;
const CONCURRENCY = Math.max(
  1,
  Math.min(
    parseInt(process.env["INGESTION_WORKER_CONCURRENCY"] || "3", 10) || 3,
    5,
  ),
);

let isShuttingDown = false;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWorkerLoop() {
  console.log(`[QueryVault Worker] Started with concurrency=${CONCURRENCY}`);

  let currentInterval = DEFAULT_POLL_INTERVAL_MS;

  while (!isShuttingDown) {
    try {
      const result = await drainIngestionJobs({ maxJobs: CONCURRENCY });
      if (result.claimed > 0) {
        console.log(
          `[QueryVault Worker] Drained cycle: claimed=${result.claimed}, succeeded=${result.succeeded}, retrying=${result.retrying}, failed=${result.failed}`,
        );
        // Reset interval to fast poll if jobs were found
        currentInterval = DEFAULT_POLL_INTERVAL_MS;
      } else {
        // Backoff slightly when queue is empty to avoid excessive DB load
        currentInterval = Math.min(currentInterval + 500, MAX_IDLE_INTERVAL_MS);
      }
    } catch (err) {
      console.error("[QueryVault Worker] Error during drain cycle:", err);
      currentInterval = MAX_IDLE_INTERVAL_MS;
    }

    if (!isShuttingDown) {
      await sleep(currentInterval);
    }
  }

  console.log("[QueryVault Worker] Worker gracefully stopped.");
}

process.on("SIGINT", () => {
  console.log("[QueryVault Worker] Received SIGINT, shutting down...");
  isShuttingDown = true;
});

process.on("SIGTERM", () => {
  console.log("[QueryVault Worker] Received SIGTERM, shutting down...");
  isShuttingDown = true;
});

runWorkerLoop().catch((err) => {
  console.error("[QueryVault Worker] Fatal error:", err);
  process.exit(1);
});
