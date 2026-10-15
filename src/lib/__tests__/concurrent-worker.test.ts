import { beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => {
  const docs = new Map<string, Record<string, unknown>>();
  const jobs: Array<Record<string, unknown>> = [];
  const chunks = new Map<string, unknown>();
  let afterEmbed: (() => void) | undefined;
  let active = 0,
    peak = 0;
  const claimed: number[] = [];
  const db = {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const builder = {
        select: (..._args: unknown[]) => builder,
        eq: (key: string, value: unknown) => {
          filters.push([key, value]);
          return builder;
        },
        gte: (..._args: unknown[]) => builder,
        in: (..._args: unknown[]) => builder,
        maybeSingle: async () => {
          const rows = table === "documents" ? [...docs.values()] : jobs;
          return {
            data: rows.find((row) => filters.every(([key, value]) => row[key] === value)) ?? null,
            error: null,
          };
        },
        then: (resolve: (value: unknown) => void) => resolve({ count: 0, error: null }),
      };
      return builder;
    },
    storage: {
      from: () => ({
        download: async () => ({ data: new Blob(["Valid source text ".repeat(20)]), error: null }),
      }),
    },
    async rpc(name: string, args: Record<string, unknown>) {
      if (name === "claim_ingestion_jobs") {
        claimed.push(Number(args["max_jobs"]));
        const selected = jobs
          .filter((job) => job["status"] === "queued")
          .slice(0, Number(args["max_jobs"]));
        for (const job of selected)
          Object.assign(job, {
            status: "running",
            locked_by: args["worker_id"],
            locked_at: new Date().toISOString(),
            attempt_count: Number(job["attempt_count"]) + 1,
          });
        return { data: selected.map((job) => ({ ...job })), error: null };
      }
      const job = jobs.find((job) => job["id"] === args["job_id"]);
      const doc = docs.get(String(job?.["document_id"]));
      if (
        !job ||
        !doc ||
        doc["status"] === "deleting" ||
        job["locked_by"] !== args["claim_worker"] ||
        job["attempt_count"] !== args["claim_attempt"]
      )
        return { data: false, error: null };
      for (const row of (args["chunk_rows"] ?? []) as Array<{ id: string }>)
        chunks.set(row.id, row);
      Object.assign(doc, args["document_patch"]);
      Object.assign(job, args["job_patch"]);
      return { data: true, error: null };
    },
  };
  return {
    db,
    docs,
    jobs,
    chunks,
    claimed,
    reset() {
      docs.clear();
      jobs.length = 0;
      chunks.clear();
      claimed.length = 0;
      active = 0;
      peak = 0;
      afterEmbed = undefined;
    },
    async embed(texts: string[]) {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      afterEmbed?.();
      return texts.map(() => [0.1]);
    },
    peak: () => peak,
    afterEmbed: (callback: () => void) => {
      afterEmbed = callback;
    },
  };
});
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: fixture.db }));
vi.mock("@/lib/ai-gateway.server", () => ({
  embedTexts: fixture.embed,
  requireAiProvider: () => ({ embeddingModel: "fixture", embeddingDimensions: 1 }),
  toVectorLiteral: (v: number[]) => JSON.stringify(v),
}));
vi.mock("@/lib/ingestion/document-parser.server", () => ({
  extractDocumentPages: async () => [
    {
      page: 1,
      text: "Deterministic document evidence with sufficient readable text for indexing. ".repeat(
        4,
      ),
    },
  ],
}));
vi.mock("@/lib/rate-limit.server", () => ({
  enforceRateLimit: async () => undefined,
  pruneExpiredRateLimits: async () => undefined,
}));
vi.mock("@/lib/observability/telemetry.server", () => ({ emitAsync: () => undefined }));
vi.mock("@/lib/api-errors", () => ({
  logEvent: () => undefined,
  newRequestId: () => crypto.randomUUID(),
}));
import { drainIngestionJobs } from "../ingestion/worker.server";
beforeEach(() => {
  fixture.reset();
  vi.stubEnv("INGESTION_WORKER_CONCURRENCY", "2");
});
function seed(count: number) {
  for (let i = 0; i < count; i++) {
    const id = crypto.randomUUID();
    fixture.docs.set(id, {
      id,
      user_id: "owner",
      filename: `doc-${i}.txt`,
      storage_path: `owner/${id}/doc-${i}.txt`,
      content_type: "text/plain",
      byte_size: new Blob(["Valid source text ".repeat(20)]).size,
      content_hash: null,
      status: "uploaded",
    });
    fixture.jobs.push({
      id: crypto.randomUUID(),
      document_id: id,
      user_id: "owner",
      status: "queued",
      attempt_count: 0,
      created_at: new Date().toISOString(),
    });
  }
}
describe("concurrent durable worker orchestration (mocked storage, database and provider)", () => {
  it("drains ten jobs to READY with real overlap, including overlapping drains and maxJobs overrides", async () => {
    seed(10);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => drainIngestionJobs({ maxJobs: 5 })),
    );
    expect(results.reduce((sum, result) => sum + result.succeeded, 0)).toBe(10);
    expect([...fixture.docs.values()].every((doc) => doc["status"] === "ready")).toBe(true);
    expect(fixture.peak()).toBe(2);
    expect(fixture.claimed.every((count) => count <= 2)).toBe(true);
    expect(fixture.chunks.size).toBe(10);
  });
  it("a replaced claim cannot write chunks or finalize the new worker's attempt", async () => {
    seed(1);
    fixture.afterEmbed(() =>
      Object.assign(fixture.jobs[0]!, { locked_by: "replacement-worker", attempt_count: 2 }),
    );
    const result = await drainIngestionJobs({ maxJobs: 1 });
    expect(result.cancelled).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(fixture.chunks.size).toBe(0);
    expect(fixture.jobs[0]!["locked_by"]).toBe("replacement-worker");
    expect(fixture.jobs[0]!["status"]).toBe("running");
    expect([...fixture.docs.values()][0]!["status"]).toBe("processing");
  });
  it("a removed document cannot be published", async () => {
    seed(1);
    const original = fixture.db.storage.from;
    fixture.db.storage.from = () => ({
      download: async () => {
        fixture.docs.clear();
        return { data: new Blob(["Valid source text ".repeat(20)]), error: null };
      },
    });
    try {
      const result = await drainIngestionJobs({ maxJobs: 1 });
      expect(result.succeeded).toBe(0);
      expect(result.cancelled).toBe(1);
      expect(fixture.chunks.size).toBe(0);
    } finally {
      fixture.db.storage.from = original;
    }
  });
});
