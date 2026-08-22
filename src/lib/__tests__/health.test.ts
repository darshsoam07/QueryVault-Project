/**
 * Health probe semantics.
 *
 * These tests exist because of a real false green found by running the probe
 * against a live Supabase project whose public schema had never been migrated:
 * every table 404'd over PostgREST, and readiness still reported
 * `database: up`. A health check that passes against an empty database is worse
 * than no health check, because a load balancer will happily route production
 * traffic at it.
 *
 * So the assertions here are mostly about the *failure* direction: each probe
 * must be capable of reporting down for the thing it claims to verify. The
 * Supabase boundary is mocked to return the exact response shapes the real
 * service returns, including the pathological one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Boundary mocks
// ---------------------------------------------------------------------------

type Result = { data: unknown; error: unknown };

let dbResult: Result;
let bucketResult: Result;
let rpcResult: { error: unknown };

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({ select: () => ({ limit: () => Promise.resolve(dbResult) }) }),
    storage: { getBucket: () => Promise.resolve(bucketResult) },
    rpc: () => Promise.resolve(rpcResult),
  },
}));

let ai: unknown;
vi.mock("@/lib/ai-gateway.server", () => ({ describeAiProvider: () => ai }));

import {
  checkApplication,
  checkDatabase,
  checkStorage,
  runLiveness,
  runReadiness,
} from "@/lib/observability/health.server";

/** What PostgREST returns for a table that is not in the schema cache. */
const MISSING_TABLE = {
  data: null,
  error: {
    code: "PGRST205",
    details: null,
    hint: null,
    message: "Could not find the table 'public.documents' in the schema cache",
  },
};

const PRIVATE_BUCKET = {
  data: { id: "documents", name: "documents", public: false },
  error: null,
};

beforeEach(() => {
  dbResult = { data: [], error: null };
  bucketResult = PRIVATE_BUCKET;
  rpcResult = { error: null };
  ai = { configured: true, provider: { label: "OpenAI" } };
  process.env["SUPABASE_URL"] = "https://example.supabase.co";
  process.env["SUPABASE_SERVICE_ROLE_KEY"] = "sb_secret_test";
});

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

describe("checkDatabase", () => {
  it("reports down when the schema is not applied", async () => {
    dbResult = MISSING_TABLE;

    const result = await checkDatabase();

    expect(result.state).toBe("down");
    expect(result.kind).toBe("dependency");
    expect(result.critical).toBe(true);
    expect(result.detail).toMatch(/schema cache/);
  });

  it("reports down when the response carries neither rows nor an error", async () => {
    // This is the shape that caused the original false green. A HEAD request
    // (`{ head: true }`) against a missing table is answered `204` with no
    // body, so `error` is null and there is no result set to inspect. Treating
    // "no error" as success made an unmigrated database look healthy.
    dbResult = { data: null, error: null };

    const result = await checkDatabase();

    expect(result.state).toBe("down");
    expect(result.detail).toMatch(/no result set/);
  });

  it("reports up for a table that exists but is empty", async () => {
    // The inverse failure matters too: a brand-new deployment with zero
    // documents is healthy, and must not be flagged.
    dbResult = { data: [], error: null };

    const result = await checkDatabase();

    expect(result.state).toBe("up");
    expect(result.detail).toBe("schema reachable");
  });

  it("reports up when a row comes back", async () => {
    dbResult = { data: [{ id: "0b6b1a9e-0000-4000-8000-000000000000" }], error: null };
    expect((await checkDatabase()).state).toBe("up");
  });

  it("blames configuration, not the database, when the env is missing", async () => {
    // Attributing our own missing environment to a `dependency` failure sends
    // an operator looking at Supabase's status page for a fault that is ours.
    delete process.env["SUPABASE_URL"];

    const result = await checkDatabase();

    expect(result.state).toBe("down");
    expect(result.kind).toBe("config");
    expect(result.detail).toBe("missing configuration: SUPABASE_URL");
  });
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

describe("checkStorage", () => {
  it("reports down when the bucket does not exist", async () => {
    // The real error object from storage-js for an unknown bucket. Note that
    // `list()` on the same bucket returns `{ data: [], error: null }`, which is
    // why the probe asks about the bucket itself instead of its contents.
    bucketResult = {
      data: null,
      error: { name: "StorageApiError", message: "Bucket not found", statusCode: "404" },
    };

    const result = await checkStorage();

    expect(result.state).toBe("down");
    expect(result.detail).toMatch(/Bucket not found/);
  });

  it("reports down as a config fault when the bucket is public", async () => {
    // Every object in this bucket is private user data. A public bucket is a
    // disclosure of all of it, not a degraded dependency.
    bucketResult = { data: { id: "documents", name: "documents", public: true }, error: null };

    const result = await checkStorage();

    expect(result.state).toBe("down");
    expect(result.kind).toBe("config");
    expect(result.detail).toMatch(/is public/);
  });

  it("reports up for a private bucket", async () => {
    const result = await checkStorage();
    expect(result.state).toBe("up");
    expect(result.detail).toMatch(/private/);
  });

  it("blames configuration, not storage, when the env is missing", async () => {
    delete process.env["SUPABASE_SERVICE_ROLE_KEY"];

    const result = await checkStorage();

    expect(result.kind).toBe("config");
    // Names the variable, never its value.
    expect(result.detail).toBe("missing configuration: SUPABASE_SERVICE_ROLE_KEY");
  });
});

// ---------------------------------------------------------------------------
// Application / liveness
// ---------------------------------------------------------------------------

describe("checkApplication", () => {
  it("names the missing configuration without printing its value", async () => {
    delete process.env["SUPABASE_SERVICE_ROLE_KEY"];

    const result = await checkApplication();

    expect(result.state).toBe("down");
    expect(result.kind).toBe("config");
    expect(result.detail).toContain("SUPABASE_SERVICE_ROLE_KEY");
    // The variable name is safe to log; the value never is.
    expect(result.detail).not.toContain("sb_secret_test");
  });

  it("is up once required configuration is present", async () => {
    expect((await checkApplication()).state).toBe("up");
  });

  it("liveness ignores dependencies entirely", async () => {
    // A third-party outage must not restart a healthy process.
    dbResult = MISSING_TABLE;
    bucketResult = { data: null, error: { message: "Bucket not found" } };

    const report = await runLiveness();

    expect(report.probe).toBe("live");
    expect(report.status).toBe("healthy");
    expect(report.checks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Rollup
// ---------------------------------------------------------------------------

describe("runReadiness", () => {
  it("is unhealthy when the database is missing", async () => {
    dbResult = MISSING_TABLE;

    const report = await runReadiness(false);

    expect(report.status).toBe("unhealthy");
    expect(report.failure).toBe("dependency");
    expect(report.checks.find((c) => c.name === "database")?.state).toBe("down");
  });

  it("attributes a public bucket to config, so the route answers 500 not 503", async () => {
    bucketResult = { data: { id: "documents", public: true }, error: null };

    const report = await runReadiness(false);

    expect(report.status).toBe("unhealthy");
    expect(report.failure).toBe("config");
  });

  it("is healthy when every critical dependency answers", async () => {
    const report = await runReadiness(false);

    expect(report.status).toBe("healthy");
    expect(report.failure).toBe("none");
    // Shallow readiness does not call the AI providers, so they stay unknown
    // rather than counting as failures.
    expect(report.checks.find((c) => c.name === "llm_provider")?.state).toBe("unknown");
  });

  it("surfaces a missing retrieval function as an application fault", async () => {
    // The SQL functions are ours, so their absence is our bug, not an outage —
    // and it means retrieval is entirely broken while the tables look fine.
    rpcResult = {
      error: { message: "Could not find the function public.lexical_document_chunks" },
    };

    const report = await runReadiness(false);

    expect(report.status).toBe("unhealthy");
    expect(report.failure).toBe("application");
    expect(report.checks.find((c) => c.name === "retrieval_function")?.state).toBe("down");
  });

  it("reports an unconfigured AI provider as config, not as an outage", async () => {
    ai = { configured: false, reason: "AI is not configured" };

    const report = await runReadiness(false);

    expect(report.failure).toBe("config");
    expect(report.checks.find((c) => c.name === "llm_provider")?.detail).toBe(
      "AI is not configured",
    );
  });
});
