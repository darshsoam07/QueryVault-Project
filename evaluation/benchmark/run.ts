import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import type { Loaded } from "./load";
import { sha256, canonical } from "./load";
import { aggregate, answerMetrics, retrievalMetrics, type Measurement } from "./metrics";
import type { Question } from "./schema";
import type { connectIsolated } from "./local";
import { RETRIEVAL_CONFIG } from "../../src/lib/retrieval/config";
import { CHUNKER_VERSION, PARSER_VERSION, WORKER_VERSION } from "../../src/lib/ingestion/contract";
type Adapter = Awaited<ReturnType<typeof connectIsolated>>;
const SAFE_CODES = new Set([
  "MANIFEST_OR_DOCUMENT_PATH_REQUIRED",
  "EXPLICIT_LOCAL_CONFIG_REQUIRED",
  "EXPLICIT_SPLIT_REQUIRED",
  "LIVE_OPT_IN_REQUIRED",
  "REVIEW_FILE_REQUIRED",
  "EXPECTED_PREPARE_PROGRESS_VALIDATE_RUN_OR_REVIEW",
  "ISOLATED_PROJECT_REQUIRED",
  "EXPLICIT_LOOPBACK_PORT_REQUIRED",
  "DEDICATED_CONTAINER_REQUIRED",
  "LOOPBACK_CONTAINER_BINDING_REQUIRED",
  "BENCHMARK_NETWORK_BOUNDARY",
  "LOCAL_SERVICE_OPERATION_FAILED",
  "DOCUMENT_PROVIDER_PERMISSION_REQUIRED",
  "BENCHMARK_DATABASE_NOT_EMPTY",
  "BENCHMARK_AUTH_NOT_EMPTY",
  "BENCHMARK_STORAGE_NOT_EMPTY",
  "BENCHMARK_USER_UNAVAILABLE",
  "BENCHMARK_SESSION_UNAVAILABLE",
  "DOCUMENT_CHANGED_BEFORE_INGESTION",
  "PRODUCTION_INGESTION_INCOMPLETE",
  "DOCUMENT_NOT_READY",
  "FOREIGN_RETRIEVAL_DOCUMENT",
  "CHAT_STREAM_ERROR",
  "CHAT_STREAM_INCOMPLETE",
  "UNSAFE_DOCUMENT_PATH",
  "UNSUPPORTED_DOCUMENT",
  "INVALID_DOCUMENT_SIZE",
  "EMPTY_EXTRACTION",
  "DUPLICATE_DOCUMENT_ID",
  "DUPLICATE_DOCUMENT_CONTENT",
  "SAMPLE_PROVENANCE_IN_REAL_DATASET",
  "DUPLICATE_QUESTION_ID",
  "SOURCE_SPAN_MISMATCH",
  "DUPLICATE_QUESTION_TEXT",
  "CROSS_SPLIT_LEAKAGE_GROUP",
  "POSSIBLE_CROSS_SPLIT_PARAPHRASE",
  "CROSS_SPLIT_SUPPORT_OVERLAP",
  "DOCUMENT_OR_EXTRACTION_HASH_MISMATCH",
  "BENCHMARK_NOT_READY",
  "INVALID_METRIC",
  "DUPLICATE_RANKED_CHUNK",
  "REVIEW_RUN_MISMATCH",
  "DUPLICATE_JUDGMENT",
  "INVALID_OR_STALE_JUDGMENT",
  "SCOPE_GENERATION_MISMATCH",
  "EMPTY_SELECTED_SPLIT",
]);
export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return SAFE_CODES.has(message) || /^CHAT_HTTP_[45]\d{2}$/.test(message)
    ? message
    : "BENCHMARK_OPERATION_FAILED";
}
export async function provenance() {
  // Include uncommitted/untracked implementation files, not only Git HEAD.
  const sourceHashes: Record<string, string> = {};
  const walk = async (root: string) => {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = `${root}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (/\.(ts|tsx|js|json)$/.test(entry.name))
        sourceHashes[path] = sha256(await readFile(path));
    }
  };
  await walk("src");
  await walk("evaluation");
  await walk("server");
  return {
    sourceSnapshotSha256: sha256(canonical(sourceHashes)),
    runtime: { node: process.version, bun: process.versions["bun"] ?? null },
    codeRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    workingTreeDiffSha256: sha256(
      execFileSync("git", ["diff", "HEAD", "--binary"], { stdio: ["ignore", "pipe", "pipe"] }),
    ),
    chatSourceSha256: sha256(await readFile("src/routes/api/chat.ts")),
    verifierSourceSha256: sha256(await readFile("src/lib/retrieval/support-verifier.server.ts")),
    packageLockSha256: sha256(await readFile("package-lock.json")),
    parserVersion: PARSER_VERSION,
    chunkerVersion: CHUNKER_VERSION,
    workerVersion: WORKER_VERSION,
    config: RETRIEVAL_CONFIG,
  };
}
export async function evaluateBenchmark(
  loaded: Loaded,
  adapter: Adapter,
  options: {
    generate: boolean;
    split: "development" | "held-out";
    scope: "isolated-live-retrieval" | "isolated-live-chat" | "mocked-contract-test";
  },
) {
  if (
    (options.scope === "isolated-live-chat") !== options.generate &&
    options.scope !== "mocked-contract-test"
  )
    throw new Error("SCOPE_GENERATION_MISMATCH");
  type Row = {
    questionId: string;
    category: Question["category"];
    difficulty: Question["difficulty"];
    split: Question["split"];
    retrieval: Awaited<ReturnType<Adapter["retrieve"]>> | null;
    generation: Awaited<ReturnType<Adapter["generate"]>> | null;
    answerHash: string | null;
    metrics: { retrieval: Record<string, Measurement>; answer: Record<string, Measurement> };
    errors: Array<{ stage: string; code: string }>;
    latencyMs: { retrieval: number | null; generation: number | null; total: number };
  };
  const rows: Row[] = [];
  for (const q of loaded.manifest.questions.filter((q) => q.split === options.split)) {
    const started = performance.now();
    let retrieval: Awaited<ReturnType<Adapter["retrieve"]>> | null = null;
    let generation: Awaited<ReturnType<Adapter["generate"]>> | null = null;
    const errors: Array<{ stage: string; code: string }> = [];
    let retrievalMs: number | null = null,
      generationMs: number | null = null;
    try {
      const start = performance.now();
      retrieval = await adapter.retrieve(q.question);
      retrievalMs = performance.now() - start;
    } catch (error) {
      errors.push({ stage: "retrieval", code: safeError(error) });
    }
    if (options.generate) {
      try {
        const start = performance.now();
        generation = await adapter.generate(q.question);
        generationMs = performance.now() - start;
      } catch (error) {
        errors.push({ stage: "generation", code: safeError(error) });
      }
    }
    const retrievalScores = retrievalMetrics(
      q,
      adapter.indexed,
      retrieval?.ranked ?? [],
      retrieval?.context ?? [],
    );
    if (!retrieval)
      for (const key of Object.keys(retrievalScores))
        retrievalScores[key] = {
          status: "unavailable",
          value: null,
          n: 0,
          reason: "Retrieval operation failed",
        };
    const answers = answerMetrics(
      q,
      generation?.answer ?? null,
      generation?.refused ?? null,
      options.generate,
    );
    rows.push({
      questionId: q.id,
      category: q.category,
      difficulty: q.difficulty,
      split: q.split,
      retrieval,
      generation,
      answerHash: generation ? sha256(generation.answer) : null,
      metrics: { retrieval: retrievalScores, answer: answers },
      errors,
      latencyMs: {
        retrieval: retrievalMs,
        generation: generationMs,
        total: performance.now() - started,
      },
    });
  }
  if (!rows.length) throw new Error("EMPTY_SELECTED_SPLIT");
  const summarize = (subset: typeof rows) => ({
    count: subset.length,
    retrieval: aggregate(subset.map((r) => r.metrics.retrieval)),
    answer: aggregate(subset.map((r) => r.metrics.answer)),
  });
  return {
    schemaVersion: 1,
    runId: randomUUID(),
    timestamp: new Date().toISOString(),
    scope: options.scope,
    datasetId: loaded.manifest.datasetId,
    datasetVersion: loaded.manifest.version,
    datasetHash: loaded.datasetHash,
    split: options.split,
    readiness: loaded.readiness,
    provider: adapter.provider,
    documents: adapter.documentIds,
    indexed: adapter.indexed,
    // No overall quality-pass claim: semantic answer review remains independent.
    executionStatus: rows.some(
      (r) =>
        r.errors.length ||
        Object.values(r.metrics.retrieval).some((m) => m.status === "unavailable"),
    )
      ? "incomplete"
      : "completed",
    answerQualityStatus: "unmeasured-pending-review",
    summary: summarize(rows),
    byCategory: Object.fromEntries(
      [...new Set(rows.map((r) => r.category))].map((c) => [
        c,
        summarize(rows.filter((r) => r.category === c)),
      ]),
    ),
    byDifficulty: Object.fromEntries(
      [...new Set(rows.map((r) => r.difficulty))].map((d) => [
        d,
        summarize(rows.filter((r) => r.difficulty === d)),
      ]),
    ),
    cases: rows,
  };
}
export type Run = Awaited<ReturnType<typeof evaluateBenchmark>>;
