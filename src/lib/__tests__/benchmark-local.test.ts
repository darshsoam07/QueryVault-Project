import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => {
  const state = { table: "", users: false, storage: false, readError: false };
  const createUser = vi.fn();
  const db = {
    from: (table: string) => ({
      select: () => ({
        limit: async () => ({
          data: state.table === table ? [{ id: "existing" }] : [],
          error: state.readError ? { message: "private upstream diagnostic" } : null,
        }),
      }),
    }),
    auth: {
      admin: {
        listUsers: async () => ({
          data: { users: state.users ? [{ id: "existing" }] : [] },
          error: null,
        }),
        createUser,
      },
    },
    storage: {
      from: () => ({
        list: async () => ({
          data: state.storage ? [{ name: "private object" }] : [],
          error: null,
        }),
      }),
    },
  };
  return {
    state,
    createUser,
    db,
    inspect: vi.fn((_command: string, args: string[]) =>
      JSON.stringify([
        {
          Name: `/${args[1]}`,
          State: { Running: true },
          Mounts: [],
          NetworkSettings: { Ports: { "8000/tcp": [{ HostIp: "127.0.0.1", HostPort: "54321" }] } },
        },
      ]),
    ),
  };
});
vi.mock("node:child_process", () => ({ execFileSync: fixture.inspect }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => fixture.db }));
vi.mock("../ai-gateway.server", () => ({
  requireAiProvider: () => ({
    id: "gemini",
    baseUrl: "https://provider.example",
    chatModel: "mock",
    utilityModel: "mock",
    embeddingModel: "mock",
    embeddingDimensions: 3072,
  }),
}));
import { connectIsolated } from "../../../evaluation/benchmark/local";
import { loadBenchmark } from "../../../evaluation/benchmark/load";
import { localConfigSchema } from "../../../evaluation/benchmark/isolation";

let previousEnv: NodeJS.ProcessEnv;
let previousFetch: typeof fetch;
beforeEach(() => {
  previousEnv = { ...process.env };
  previousFetch = globalThis.fetch;
  Object.assign(fixture.state, { table: "", users: false, storage: false, readError: false });
  vi.clearAllMocks();
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
  globalThis.fetch = previousFetch;
});

// Entire Docker/Auth/Storage/database boundary is mocked. No local service or
// provider is contacted, and these tests never produce a live benchmark report.
describe("benchmark local adapter preflight (mocked boundaries)", () => {
  const config = localConfigSchema.parse({
    projectId: "queryvault-benchmark",
    supabaseUrl: "http://127.0.0.1:54321",
    publishableKey: "synthetic",
    serviceRoleKey: "synthetic",
    provider: {},
  });
  const input = async () => {
    const loaded = await loadBenchmark("evaluation/benchmark/sample/manifest.json");
    for (const doc of loaded.manifest.documents) doc.provenance.providerUseAllowed = true;
    return loaded;
  };
  it("refuses before Docker/DB access without live opt-in", async () => {
    await expect(connectIsolated(config, await input(), false)).rejects.toThrow(
      "LIVE_OPT_IN_REQUIRED",
    );
    expect(fixture.inspect).not.toHaveBeenCalled();
    expect(fixture.createUser).not.toHaveBeenCalled();
  });
  it("refuses before Docker/DB access without document provider permission", async () => {
    const loaded = await input();
    loaded.manifest.documents[0]!.provenance.providerUseAllowed = false;
    await expect(connectIsolated(config, loaded, true)).rejects.toThrow(
      "DOCUMENT_PROVIDER_PERMISSION_REQUIRED",
    );
    expect(fixture.inspect).not.toHaveBeenCalled();
  });
  it.each(["documents", "ingestion_jobs", "threads", "messages"])(
    "never creates a user when %s already contains data",
    async (table) => {
      fixture.state.table = table;
      await expect(connectIsolated(config, await input(), true)).rejects.toThrow(
        "BENCHMARK_DATABASE_NOT_EMPTY",
      );
      expect(fixture.createUser).not.toHaveBeenCalled();
      expect(globalThis.fetch).toBe(previousFetch);
    },
  );
  it.each(["users", "storage"] as const)("refuses existing %s before mutation", async (field) => {
    fixture.state[field] = true;
    await expect(connectIsolated(config, await input(), true)).rejects.toThrow(
      field === "users" ? "BENCHMARK_AUTH_NOT_EMPTY" : "BENCHMARK_STORAGE_NOT_EMPTY",
    );
    expect(fixture.createUser).not.toHaveBeenCalled();
  });
  it("fails closed on unavailable database reads and clears inherited production configuration", async () => {
    process.env["SUPABASE_URL"] = "https://production.example";
    process.env["OPENAI_API_KEY"] = "synthetic-do-not-use";
    fixture.state.readError = true;
    await expect(connectIsolated(config, await input(), true)).rejects.toThrow(
      "LOCAL_SERVICE_OPERATION_FAILED",
    );
    expect(fixture.createUser).not.toHaveBeenCalled();
    expect(process.env["SUPABASE_URL"]).toBe(config.supabaseUrl);
    expect(process.env["OPENAI_API_KEY"]).toBeUndefined();
  });
});
