import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { Loaded } from "./load";
import { sha256 } from "./load";
import { aggregate, answerMetrics, retrievalMetrics } from "./metrics";
import type { connectIsolated } from "./local";
import { RETRIEVAL_CONFIG } from "../../src/lib/retrieval/config";
import { CHUNKER_VERSION, PARSER_VERSION, WORKER_VERSION } from "../../src/lib/ingestion/contract";
type Adapter = Awaited<ReturnType<typeof connectIsolated>>;
export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^[A-Z][A-Z0-9_:-]{0,100}$/.test(message) ? message : "BENCHMARK_OPERATION_FAILED";
}
export async function provenance() {
  return {
    codeRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    workingTreeDiffSha256: sha256(execFileSync("git", ["diff", "HEAD", "--binary"], { stdio: ["ignore", "pipe", "pipe"] })),
    chatSourceSha256: sha256(await readFile("src/routes/api/chat.ts")),
    verifierSourceSha256: sha256(await readFile("src/lib/retrieval/support-verifier.server.ts")),
    packageLockSha256: sha256(await readFile("package-lock.json")),
    parserVersion: PARSER_VERSION, chunkerVersion: CHUNKER_VERSION, workerVersion: WORKER_VERSION,
    config: RETRIEVAL_CONFIG,
  };
}
export async function evaluateBenchmark(loaded: Loaded, adapter: Adapter, options: { generate: boolean; split: "development" | "held-out"; scope: "isolated-live-retrieval" | "isolated-live-chat" | "mocked-contract-test" }) {
  if ((options.scope === "isolated-live-chat") !== options.generate && options.scope !== "mocked-contract-test") throw new Error("SCOPE_GENERATION_MISMATCH");
  const rows = [];
  for (const q of loaded.manifest.questions.filter(q => q.split === options.split)) {
    const started = performance.now();
    let retrieval: Awaited<ReturnType<Adapter["retrieve"]>> | null = null;
    let generation: Awaited<ReturnType<Adapter["generate"]>> | null = null;
    const errors: Array<{stage: string; code: string}> = [];
    let retrievalMs: number | null = null, generationMs: number | null = null;
    try {
      const start = performance.now(); retrieval = await adapter.retrieve(q.question); retrievalMs = performance.now() - start;
    } catch (error) { errors.push({ stage: "retrieval", code: safeError(error) }); }
    if (options.generate) {
      try {
        const start = performance.now(); generation = await adapter.generate(q.question); generationMs = performance.now() - start;
      } catch (error) { errors.push({ stage: "generation", code: safeError(error) }); }
    }
    const retrievalScores = retrievalMetrics(q, adapter.indexed, retrieval?.ranked ?? [], retrieval?.context ?? []);
    if (!retrieval) for (const key of Object.keys(retrievalScores)) retrievalScores[key] = { status: "unavailable", value: null, n: 0, reason: "Retrieval operation failed" };
    const answers = answerMetrics(q, generation?.answer ?? null, generation?.refused ?? null, options.generate);
    rows.push({ questionId: q.id, category: q.category, difficulty: q.difficulty, split: q.split,
      retrieval, generation, answerHash: generation ? sha256(generation.answer) : null,
      metrics: { retrieval: retrievalScores, answer: answers }, errors,
      latencyMs: { retrieval: retrievalMs, generation: generationMs, total: performance.now() - started },
    });
  }
  if (!rows.length) throw new Error("EMPTY_SELECTED_SPLIT");
  const summarize = (subset: typeof rows) => ({ count: subset.length, retrieval: aggregate(subset.map(r => r.metrics.retrieval)), answer: aggregate(subset.map(r => r.metrics.answer)) });
  return {
    schemaVersion: 1, runId: randomUUID(), timestamp: new Date().toISOString(), scope: options.scope,
    datasetId: loaded.manifest.datasetId, datasetVersion: loaded.manifest.version, datasetHash: loaded.datasetHash,
    split: options.split, readiness: loaded.readiness, provider: adapter.provider,
    documents: adapter.documentIds, indexed: adapter.indexed,
    // No overall quality-pass claim: semantic answer review remains independent.
    executionStatus: rows.some(r => r.errors.length) ? "incomplete" : "completed",
    answerQualityStatus: "unmeasured-pending-review", summary: summarize(rows),
    byCategory: Object.fromEntries([...new Set(rows.map(r => r.category))].map(c => [c, summarize(rows.filter(r => r.category === c))])),
    byDifficulty: Object.fromEntries([...new Set(rows.map(r => r.difficulty))].map(d => [d, summarize(rows.filter(r => r.difficulty === d))])),
    cases: rows,
  };
}
export type Run = Awaited<ReturnType<typeof evaluateBenchmark>>;
