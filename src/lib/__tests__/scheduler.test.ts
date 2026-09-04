import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const migration = readFileSync(
  join(root, "supabase", "migrations", "20260904000000_schedule_ingestion_worker.sql"),
  "utf8",
);
const workerRoute = readFileSync(
  join(root, "src", "routes", "api", "public", "worker-drain.ts"),
  "utf8",
);

describe("durable ingestion scheduling", () => {
  it("uses one idempotently-created minute schedule for the existing drain endpoint", () => {
    expect(migration).toMatch(/cron\.schedule\([\s\S]*queryvault-ingestion-worker/i);
    expect(migration).toMatch(/\* \* \* \* \*/);
    expect(migration).toMatch(/if not exists[\s\S]*cron\.job/i);
    expect(migration).toMatch(/net\.http_post/i);
    expect(migration).toMatch(/trigger_ingestion_worker/i);
  });

  it("loads the endpoint and credential from Vault rather than migration literals", () => {
    expect(migration).toMatch(/vault\.decrypted_secrets/i);
    expect(migration).toMatch(/queryvault_worker_drain_url/);
    expect(migration).toMatch(/queryvault_ingestion_worker_secret/);
    expect(migration).not.toMatch(/https:\/\/[^\s']/i);
  });

  it("keeps the scheduler endpoint authenticated with the canonical header only", () => {
    expect(migration).toMatch(/'x-worker-secret',\s*worker_secret/i);
    expect(workerRoute).toMatch(/headers\.get\("x-worker-secret"\)/);
    expect(workerRoute).not.toMatch(/x-worker-token/);
    expect(workerRoute).not.toMatch(/worker_credentials/);
  });
});
