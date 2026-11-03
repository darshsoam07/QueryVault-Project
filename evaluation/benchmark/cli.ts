import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { loadBenchmark, extractFile } from "./load";
import { localConfigSchema } from "./isolation";
import { provenance, evaluateBenchmark, safeError, type Run } from "./run";
import { applyReviews } from "./review";
import { benchmarkProgress } from "./progress";

// Private artifacts are never written to public/, src/ or tracked corpus files.
const outputRoot = resolve(".verification/benchmark-private");
async function save(name: string, value: unknown) {
  await mkdir(outputRoot, { recursive: true });
  const path = resolve(outputRoot, name);
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return path;
}
const [command, path, ...args] = process.argv.slice(2);
try {
  if (!path) throw new Error("MANIFEST_OR_DOCUMENT_PATH_REQUIRED");
  if (command === "prepare") {
    const result = await extractFile(resolve(path));
    const saved = await save(`extraction-${Date.now()}.json`, {
      filename: basename(path),
      sha256: result.sha256,
      extractionSha256: result.extractionSha256,
      pages: result.pages,
      status: "unreviewed-source-extraction",
      spanConvention: "UTF-16 page text offsets, zero-based start, exclusive end",
    });
    console.log(JSON.stringify({ status: "prepared-not-reviewed", artifact: saved }));
  } else if (command === "progress") {
    console.log(JSON.stringify(await benchmarkProgress(path)));
  } else if (command === "validate") {
    const loaded = await loadBenchmark(path, args.includes("--ready"));
    console.log(
      JSON.stringify({
        status: loaded.readiness.length ? "valid-draft-not-ready" : "ready",
        datasetHash: loaded.datasetHash,
        questions: loaded.manifest.questions.length,
        documents: loaded.manifest.documents.length,
        pending: loaded.readiness,
      }),
    );
  } else if (command === "run") {
    const loaded = await loadBenchmark(path, true);
    const configAt = args.indexOf("--config"),
      splitAt = args.indexOf("--split");
    if (configAt < 0 || !args[configAt + 1]) throw new Error("EXPLICIT_LOCAL_CONFIG_REQUIRED");
    const split = args[splitAt + 1];
    if (splitAt < 0 || (split !== "development" && split !== "held-out"))
      throw new Error("EXPLICIT_SPLIT_REQUIRED");
    if (!args.includes("--live")) throw new Error("LIVE_OPT_IN_REQUIRED");
    const config = localConfigSchema.parse(JSON.parse(await readFile(args[configAt + 1]!, "utf8")));
    const generate = args.includes("--generate");
    const reproducibility = await provenance();
    const original = {
      log: console.log,
      warn: console.warn,
      error: console.error,
      info: console.info,
    };
    // Production internals can log upstream errors. Keep them off the benchmark
    // console; record allowlisted failure codes and private artifacts instead.
    for (const method of ["log", "warn", "error", "info"] as const) console[method] = () => {};
    let adapter: Awaited<ReturnType<(typeof import("./local"))["connectIsolated"]>> | undefined;
    let report: unknown;
    try {
      const { connectIsolated } = await import("./local");
      adapter = await connectIsolated(config, loaded, true);
      report = {
        ...(await evaluateBenchmark(loaded, adapter, {
          generate,
          split,
          scope: generate ? "isolated-live-chat" : "isolated-live-retrieval",
        })),
        reproducibility,
      };
    } catch (error) {
      report = {
        schemaVersion: 1,
        timestamp: new Date().toISOString(),
        datasetHash: loaded.datasetHash,
        datasetId: loaded.manifest.datasetId,
        datasetVersion: loaded.manifest.version,
        reproducibility,
        provider: { status: "unavailable", reason: "Run setup failed" },
        scope: "isolated-run-unavailable",
        executionStatus: "failed",
        error: safeError(error),
        metrics: null,
      };
      process.exitCode = 1;
    } finally {
      adapter?.close();
      Object.assign(console, original);
    }
    const saved = await save(`run-${Date.now()}.json`, report);
    if ((report as { executionStatus: string }).executionStatus === "incomplete")
      process.exitCode = 1;
    console.log(
      JSON.stringify({
        status: (report as { executionStatus: string }).executionStatus,
        artifact: saved,
      }),
    );
  } else if (command === "review") {
    if (!args[0]) throw new Error("REVIEW_FILE_REQUIRED");
    const run = JSON.parse(await readFile(path, "utf8")) as Run;
    const reviewed = applyReviews(run, JSON.parse(await readFile(args[0], "utf8")));
    const saved = await save(`review-${Date.now()}.json`, reviewed);
    console.log(JSON.stringify({ status: reviewed.status, artifact: saved }));
  } else throw new Error("EXPECTED_PREPARE_PROGRESS_VALIDATE_RUN_OR_REVIEW");
} catch (error) {
  console.error(JSON.stringify({ status: "failed", code: safeError(error) }));
  process.exitCode = 1;
}
