import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => {
  const docs = new Map<string, Record<string, unknown>>();
  const jobs: Array<Record<string, unknown>> = [];
  const chunks = new Map<string, unknown>();
  let afterEmbed: (() => void) | undefined;
  let active = 0,
    peak = 0;
  const claimed: number[] = [];
  const faults = {
    mode: "none",
    logs: [] as Array<{ event: string; fields: Record<string, unknown> }>,
  };
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
          if (
            (table === "ingestion_jobs" && faults.mode === "claim_read_error") ||
            (table === "documents" && faults.mode === "document_read_error")
          )
            return { data: null, error: { code: "08006" } };
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
        download: async () => {
          if (faults.mode === "storage_hang") return new Promise<never>(() => {});
          if (faults.mode === "storage_503") return { data: null, error: { statusCode: "503" } };
          if (faults.mode === "storage_404") return { data: null, error: { statusCode: "404" } };
          return { data: new Blob(["Valid source text ".repeat(20)]), error: null };
        },
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
      const patch = args["document_patch"] as Record<string, unknown> | undefined;
      if (
        (args["job_patch"] as Record<string, unknown> | undefined)?.["locked_at"] &&
        faults.mode.startsWith("heartbeat_")
      ) {
        if (faults.mode === "heartbeat_error") return { data: false, error: { code: "08006" } };
        if (faults.mode === "heartbeat_reject") throw new Error("synthetic transport rejection");
        if (faults.mode === "heartbeat_false") {
          if (job) job["locked_by"] = "replacement";
          return { data: false, error: null };
        }
      }
      if (faults.mode === "phase_write_error" && patch?.["phase"] === "validating")
        return { data: false, error: { code: "08006" } };
      if (faults.mode === "vector_rejected" && ((args["chunk_rows"] ?? []) as unknown[]).length > 0)
        return { data: false, error: null };
      if (faults.mode === "schema_mismatch") return { data: null, error: { code: "PGRST202" } };
      if (faults.mode.startsWith("schema_code_"))
        return {
          data: null,
          error: {
            code: faults.mode.slice("schema_code_".length),
            message: "private synthetic error must not be logged",
            details: "private details",
          },
        };
      if (faults.mode === "phase_write_hang" && patch?.["phase"] === "validating")
        return new Promise<never>(() => {});
      if (faults.mode === "persist_error") return { data: null, error: { code: "08006" } };
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
      if (faults.mode === "publication_response_hang" && patch?.["status"] === "ready")
        return new Promise<never>(() => {});
      return { data: true, error: null };
    },
  };
  return {
    db,
    docs,
    jobs,
    chunks,
    claimed,
    faults,
    reset() {
      docs.clear();
      jobs.length = 0;
      chunks.clear();
      claimed.length = 0;
      active = 0;
      peak = 0;
      afterEmbed = undefined;
      faults.mode = "none";
      faults.logs.length = 0;
    },
    async embed(texts: string[]) {
      if (faults.mode === "embedding_hang") return new Promise<never>(() => {});
      if (faults.mode === "embedding_quota")
        throw Object.assign(new Error("insufficient_quota"), {
          status: 402,
          code: "insufficient_quota",
        });
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
  extractDocumentPages: async () => {
    if (fixture.faults.mode === "parser_hang" || fixture.faults.mode.startsWith("heartbeat_"))
      return new Promise<never>(() => {});
    return [
      {
        page: 1,
        text: "Deterministic document evidence with sufficient readable text for indexing. ".repeat(
          4,
        ),
      },
    ];
  },
}));
vi.mock("@/lib/rate-limit.server", () => ({
  enforceRateLimit: async () => undefined,
  pruneExpiredRateLimits: async () => undefined,
}));
vi.mock("@/lib/observability/telemetry.server", () => ({ emitAsync: () => undefined }));
vi.mock("@/lib/api-errors", () => ({
  logEvent: (_level: string, event: string, _request: string, fields: Record<string, unknown>) => {
    fixture.faults.logs.push({ event, fields });
  },
  newRequestId: () => crypto.randomUUID(),
}));
import { drainIngestionJobs } from "../ingestion/worker.server";
beforeEach(() => {
  fixture.reset();
  vi.stubEnv("INGESTION_WORKER_CONCURRENCY", "2");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
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
  it.each([
    ["heartbeat_error", "worker.lease_renewal_rejected"],
    ["heartbeat_false", "worker.lease_renewal_rejected"],
    ["heartbeat_reject", "worker.lease_renewal_failed"],
    ["heartbeat_success", "worker.lease_renewed"],
  ])("observes %s without inventing a successful renewal", async (mode, event) => {
    vi.useFakeTimers();
    seed(1);
    fixture.faults.mode = mode!;
    const drain = drainIngestionJobs({ maxJobs: 1 });
    await vi.advanceTimersByTimeAsync(30001);
    expect(fixture.faults.logs.some((log) => log.event === event)).toBe(true);
    if (mode !== "heartbeat_success")
      expect(fixture.faults.logs.some((log) => log.event === "worker.lease_renewed")).toBe(false);
    await vi.advanceTimersByTimeAsync(30001);
    await drain;
    expect(fixture.chunks.size).toBe(0);
    expect([...fixture.docs.values()][0]!["status"]).not.toBe("ready");
    // Rejected/failed renewals stop; a healthy renewal may run again at 60s.
    if (mode !== "heartbeat_success")
      expect(fixture.faults.logs.filter((log) => log.event === event)).toHaveLength(1);
  });
  it("releases the serialized drain after bounded network failure so a later drain can claim", async () => {
    vi.useFakeTimers();
    seed(2);
    fixture.faults.mode = "phase_write_hang";
    const blocked = drainIngestionJobs({ maxJobs: 1 });
    const later = drainIngestionJobs({ maxJobs: 1 });
    await vi.advanceTimersByTimeAsync(15001);
    expect((await blocked).retrying).toBe(1);
    await vi.advanceTimersByTimeAsync(15001);
    expect((await later).retrying).toBe(1);
    expect(fixture.claimed).toEqual([1, 1]);
    expect(fixture.jobs.map((job) => job["status"])).toEqual(["retrying", "retrying"]);
    expect(fixture.chunks.size).toBe(0);
  });
  it("records a first validating phase database failure instead of silent cancellation", async () => {
    seed(1);
    fixture.faults.mode = "phase_write_error";
    const result = await drainIngestionJobs({ maxJobs: 1 });
    expect(result.retrying).toBe(1);
    expect(result.cancelled).toBe(0);
    expect(fixture.jobs[0]).toMatchObject({ status: "retrying", error_code: "CLAIM_WRITE_FAILED" });
    expect(fixture.chunks.size).toBe(0);
  });
  it("does not undo an atomic READY commit when its response is lost", async () => {
    seed(1);
    fixture.faults.mode = "publication_response_hang";
    const result = drainIngestionJobs({ maxJobs: 1 });
    expect((await result).failed).toBe(0);
    expect([...fixture.docs.values()][0]).toMatchObject({ status: "ready", progress: 100 });
    expect(fixture.jobs[0]!["status"]).toBe("succeeded");
    expect(fixture.chunks.size).toBe(1);
  }, 20000);
  it("does not hide a live-claim vector rejection as cancellation", async () => {
    seed(1);
    fixture.jobs[0]!["max_attempts"] = 1;
    fixture.faults.mode = "vector_rejected";
    const result = await drainIngestionJobs({ maxJobs: 1 });
    expect(result.failed).toBe(1);
    expect(result.cancelled).toBe(0);
    expect([...fixture.docs.values()][0]).toMatchObject({
      status: "failed",
      failure_code: "CLAIM_WRITE_REJECTED",
    });
    expect(fixture.chunks.size).toBe(0);
  });
  it.each(["PGRST202", "PGRST203", "42883", "42703"])(
    "identifies %s without pretending the failure was persisted",
    async (code) => {
      seed(1);
      fixture.faults.mode = `schema_code_${code}`;
      const result = await drainIngestionJobs({ maxJobs: 1 });
      expect(result.unconfirmed).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.succeeded).toBe(0);
      for (const stage of ["phase_write.validating", "record_failure"]) {
        expect(fixture.faults.logs).toEqual(
          expect.arrayContaining([
            {
              event: "worker.stage",
              fields: expect.objectContaining({ stage, outcome: "failed", error_code: code }),
            },
          ]),
        );
        expect(
          fixture.faults.logs.some(
            (log) =>
              log.event === "worker.stage" &&
              log.fields["stage"] === stage &&
              log.fields["outcome"] === "completed",
          ),
        ).toBe(false);
      }
      expect(JSON.stringify(fixture.faults.logs)).not.toContain("private");
      expect(fixture.chunks.size).toBe(0);
      expect(fixture.faults.logs).toEqual(
        expect.arrayContaining([
          {
            event: "worker.failure_recording_deferred",
            fields: expect.objectContaining({ original_error_code: "RPC_SCHEMA_MISMATCH" }),
          },
        ]),
      );
    },
  );
  it.each([
    ["phase_write_hang", 15001, "phase_write.validating"],
    ["storage_hang", 30001, "storage_download"],
    ["parser_hang", 60001, "parse"],
    ["embedding_hang", 75001, "embedding"],
  ] as const)(
    "bounds %s and records its exact stage without publishing READY",
    async (mode, elapsed, stage) => {
      vi.useFakeTimers();
      seed(1);
      fixture.faults.mode = mode;
      const result = drainIngestionJobs({ maxJobs: 1 });
      await vi.advanceTimersByTimeAsync(elapsed);
      expect((await result).retrying).toBe(1);
      expect(fixture.chunks.size).toBe(0);
      expect([...fixture.docs.values()][0]!["status"]).not.toBe("ready");
      expect(fixture.jobs[0]!["error_code"]).toBe("STAGE_TIMEOUT");
      expect(fixture.faults.logs).toEqual(
        expect.arrayContaining([
          {
            event: "worker.stage",
            fields: expect.objectContaining({
              stage,
              outcome: "failed",
              error_code: "STAGE_TIMEOUT",
            }),
          },
        ]),
      );
    },
  );
  it.each(["claim_read_error", "document_read_error", "storage_503"])(
    "classifies %s as retryable instead of deletion or missing file",
    async (mode) => {
      seed(1);
      fixture.faults.mode = mode;
      const result = await drainIngestionJobs({ maxJobs: 1 });
      expect(result.retrying).toBe(1);
      expect(result.cancelled).toBe(0);
      expect(result.succeeded).toBe(0);
    },
  );
  it.each([
    ["storage_404", "MISSING_OBJECT"],
    ["embedding_quota", "CREDITS_EXHAUSTED"],
  ])("publishes terminal %s failures with a visible code", async (mode, code) => {
    seed(1);
    fixture.faults.mode = mode!;
    const result = await drainIngestionJobs({ maxJobs: 1 });
    expect(result.failed).toBe(1);
    expect([...fixture.docs.values()][0]).toMatchObject({ status: "failed", failure_code: code });
    expect(fixture.chunks.size).toBe(0);
  });
  it("reports unconfirmed persistence rather than a false cancellation", async () => {
    seed(1);
    fixture.faults.mode = "persist_error";
    const result = await drainIngestionJobs({ maxJobs: 1 });
    expect(result.unconfirmed).toBe(1);
    expect(result.cancelled).toBe(0);
    expect(result.failed).toBe(0);
    expect(
      fixture.faults.logs.some((log) => log.event === "worker.failure_recording_deferred"),
    ).toBe(true);
  });
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
