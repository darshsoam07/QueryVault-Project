/**
 * Offline evaluation runner for the retrieval pipeline.
 *
 * Runs the REAL pipeline (expansion → dense + lexical → RRF fusion → rerank →
 * evidence gate → context budget) against a deterministic fixture corpus, so
 * quality regressions are caught in CI without a database, an API key or a
 * network call.
 *
 *   bun evaluation/runner.ts            # print a report
 *   bun evaluation/runner.ts --json     # machine-readable
 *   bun evaluation/runner.ts --gate     # exit 1 when thresholds are missed
 */
import { heuristicReranker } from "../src/lib/retrieval/reranker";
import { RETRIEVAL_CONFIG } from "../src/lib/retrieval/config";
import { runRetrieval, type RetrievalDeps } from "../src/lib/retrieval/pipeline";
import type { Candidate } from "../src/lib/retrieval/types";
import { CATEGORIES, EVAL_CASES, type EvalCase } from "./dataset";
import { cosine, embedQuestion, FIXTURE_CHUNKS, lexicalScore } from "./fixtures";
import thresholds from "./thresholds.json" with { type: "json" };
import {
  falseRefusalRate,
  mean,
  meanReciprocalRank,
  ndcgAtK,
  precisionAtK,
  recallAtK,
  reciprocalRank,
  refusalAccuracy,
} from "./metrics";

function toCandidate(
  chunk: (typeof FIXTURE_CHUNKS)[number],
  index: number,
  similarity: number | null,
  lexicalRank: number | null,
): Candidate {
  return {
    chunkId: chunk.chunkId,
    documentId: chunk.documentId,
    filename: chunk.filename,
    page: chunk.page,
    chunkIndex: index,
    content: chunk.content,
    similarity,
    lexicalRank,
    densePosition: similarity === null ? null : index + 1,
    lexicalPosition: lexicalRank === null ? null : index + 1,
  };
}

/** Fixture-backed stand-ins for the Supabase retrievers. */
export function createFixtureDeps(): RetrievalDeps {
  return {
    config: RETRIEVAL_CONFIG,
    expand: async (question) => ({ queries: [question], rewritten: false }),
    dense: async (queries) => {
      const scored = FIXTURE_CHUNKS.map((chunk) => ({
        chunk,
        similarity: Math.max(...queries.map((q) => cosine(embedQuestion(q), chunk.vector))),
      }))
        .filter((row) => row.similarity >= RETRIEVAL_CONFIG.minSimilarity)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, RETRIEVAL_CONFIG.denseCandidates);
      return {
        candidates: scored.map((row, i) => toCandidate(row.chunk, i, row.similarity, null)),
        embeddingLatencyMs: 0,
        queryLatencyMs: 0,
      };
    },
    lexical: async (queries) => {
      const scored = FIXTURE_CHUNKS.map((chunk) => ({
        chunk,
        rank: Math.max(...queries.map((q) => lexicalScore(q, chunk.content))),
      }))
        .filter((row) => row.rank > 0)
        .sort((a, b) => b.rank - a.rank)
        .slice(0, RETRIEVAL_CONFIG.lexicalCandidates);
      return {
        candidates: scored.map((row, i) => toCandidate(row.chunk, i, null, row.rank)),
        queryLatencyMs: 0,
      };
    },
    reranker: heuristicReranker,
  };
}

export type CaseResult = {
  id: string;
  category: EvalCase["category"];
  refused: boolean;
  expectRefusal: boolean;
  refusalStage: "retrieval" | "generation";
  rankedIds: string[];
  evidenceIds: string[];
  recallAt5: number;
  recallAt10: number;
  precisionAt5: number;
  reciprocalRank: number;
  ndcgAt10: number;
  evidencePrecision: number;
  evidenceIdsValid: boolean;
  evidenceMarkerContainment: boolean;
  crossDocumentSatisfied: boolean;
  gateReason: string;
};

/**
 * Measures retrieval and evidence structure only. No answer is generated;
 * citation support, hallucinations and model injection resistance are unmeasured.
 */
export async function runCase(evalCase: EvalCase, deps: RetrievalDeps): Promise<CaseResult> {
  const outcome = await runRetrieval(evalCase.question, deps);
  const rankedIds = outcome.ranked.map((candidate) => candidate.chunkId);
  const evidence = outcome.context.sources;
  const evidenceIds = evidence.map((source) => source.chunkId);
  const refused = !outcome.verdict.grounded;

  // Structural containment only: adversarial text must reach the model as quoted,
  // id-tagged evidence — never as bare instruction text. We assert that every
  // forbidden marker present in the context sits inside an <evidence> element
  // and that source ids keep their immutable, model-uncontrollable form.
  const evidenceMarkerContainment = (evalCase.forbiddenInAnswer ?? []).every((marker) =>
    isEnclosedInEvidence(outcome.context.contextBlock, marker),
  );

  // Check actual context IDs, not citations manufactured from those same IDs.
  const evidenceIdsValid =
    (refused || evidence.length > 0) &&
    new Set(evidence.map((source) => source.sourceId)).size === evidence.length &&
    new Set(evidenceIds).size === evidence.length &&
    evidence.every(
      (source) =>
        /^source_\d{2}$/.test(source.sourceId) &&
        outcome.ranked.some(
          (candidate) =>
            candidate.chunkId === source.chunkId && candidate.documentId === source.documentId,
        ),
    );

  const documentIds = new Set(evidence.map((source) => source.documentId));
  const crossDocumentSatisfied = (evalCase.requiredDocumentIds ?? []).every((id) =>
    documentIds.has(id),
  );

  return {
    id: evalCase.id,
    category: evalCase.category,
    refused,
    expectRefusal: Boolean(evalCase.expectRefusal),
    refusalStage: evalCase.refusalStage ?? "retrieval",
    rankedIds,
    evidenceIds,
    recallAt5: recallAtK(rankedIds, evalCase.relevantChunkIds, 5),
    recallAt10: recallAtK(rankedIds, evalCase.relevantChunkIds, 10),
    precisionAt5: precisionAtK(rankedIds, evalCase.relevantChunkIds, 5),
    reciprocalRank: evalCase.relevantChunkIds.length
      ? reciprocalRank(rankedIds, evalCase.relevantChunkIds)
      : 1,
    ndcgAt10: ndcgAtK(rankedIds, evalCase.relevantChunkIds, 10),
    evidencePrecision: evalCase.relevantChunkIds.length
      ? precisionAtK(evidenceIds, evalCase.relevantChunkIds, evidenceIds.length)
      : 1,
    evidenceIdsValid,
    evidenceMarkerContainment,
    crossDocumentSatisfied,
    gateReason: outcome.verdict.reason,
  };
}

export type EvalReport = {
  scope: "offline-fixture-retrieval";
  unmeasured: string[];
  cases: CaseResult[];
  overall: Record<string, number>;
  perCategory: Record<string, Record<string, number>>;
  violations: string[];
  passed: boolean;
};

export async function runEvaluation(
  deps: RetrievalDeps = createFixtureDeps(),
  dataset: EvalCase[] = EVAL_CASES,
): Promise<EvalReport> {
  const datasetViolations = validateDataset(dataset);
  const cases: CaseResult[] = [];
  for (const evalCase of dataset) {
    cases.push(await runCase(evalCase, deps));
  }

  const answerable = cases.filter((c) => !c.expectRefusal);
  const gateNegatives = cases.filter((c) => c.expectRefusal && c.refusalStage === "retrieval");
  const injectionCases = cases.filter((c) => c.category === "injection");
  const crossDocCases = cases.filter((c) => c.category === "cross-document");

  const overall = {
    cases: cases.length,
    answerable_cases: answerable.length,
    retrieval_negative_cases: gateNegatives.length,
    generation_negative_cases_unmeasured: cases.filter(
      (c) => c.expectRefusal && c.refusalStage === "generation",
    ).length,
    recall_at_5: mean(answerable.map((c) => c.recallAt5)),
    recall_at_10: mean(answerable.map((c) => c.recallAt10)),
    precision_at_5: mean(answerable.map((c) => c.precisionAt5)),
    mrr: meanReciprocalRank(answerable.map((c) => c.reciprocalRank)),
    ndcg_at_10: mean(answerable.map((c) => c.ndcgAt10)),
    evidence_precision: mean(answerable.map((c) => c.evidencePrecision)),
    evidence_ids_valid: cases.every((c) => c.evidenceIdsValid) ? 1 : 0,
    retrieval_refusal_accuracy: refusalAccuracy(
      gateNegatives.map((c) => ({ refused: c.refused, expectRefusal: true })),
    ),
    false_refusal_rate: falseRefusalRate(cases),
    evidence_marker_containment: injectionCases.length
      ? injectionCases.filter((c) => c.evidenceMarkerContainment).length / injectionCases.length
      : 1,
    cross_document_coverage: crossDocCases.length
      ? crossDocCases.filter((c) => c.crossDocumentSatisfied).length / crossDocCases.length
      : 1,
  };

  const perCategory: Record<string, Record<string, number>> = {};
  for (const category of CATEGORIES) {
    const subset = cases.filter((c) => c.category === category);
    if (subset.length === 0) continue;
    perCategory[category] = {
      cases: subset.length,
      ...(category === "negative"
        ? {}
        : {
            recall_at_5: mean(subset.map((c) => c.recallAt5)),
            mrr: meanReciprocalRank(subset.map((c) => c.reciprocalRank)),
          }),
    };
  }

  const violations = [...datasetViolations, ...collectViolations(overall, perCategory)];
  return {
    scope: "offline-fixture-retrieval",
    unmeasured: [
      "answer correctness",
      "answer faithfulness",
      "generated citation support",
      "model injection resistance",
      "generation-stage refusal",
    ],
    cases,
    overall,
    perCategory,
    violations,
    passed: violations.length === 0,
  };
}

/** Fixture labels must refer to real corpus members and preserve negative coverage. */
export function validateDataset(dataset: EvalCase[]): string[] {
  const violations: string[] = [];
  const seen = new Set<string>();
  const chunks = new Map(FIXTURE_CHUNKS.map((chunk) => [chunk.chunkId, chunk]));
  for (const item of dataset) {
    const fail = (reason: string) => violations.push(`[${item.id}] ${reason}`);
    if (!item.id.trim() || seen.has(item.id)) fail("missing or duplicate case id");
    seen.add(item.id);
    if (!item.question.trim()) fail("empty question");
    if (!CATEGORIES.includes(item.category)) fail("unknown category");
    if (new Set(item.relevantChunkIds).size !== item.relevantChunkIds.length)
      fail("duplicate relevant chunk ids");
    for (const id of item.relevantChunkIds)
      if (!chunks.has(id)) fail(`unknown relevant chunk ${id}`);
    if (item.expectRefusal ? item.relevantChunkIds.length > 0 : item.relevantChunkIds.length === 0)
      fail("refusal expectation and relevance labels disagree");
    if ((item.category === "negative") !== Boolean(item.expectRefusal))
      fail("negative category and refusal expectation disagree");
    if (
      item.refusalStage &&
      (!item.expectRefusal || !["retrieval", "generation"].includes(item.refusalStage))
    )
      fail("invalid refusal stage");
    const required = item.requiredDocumentIds ?? [];
    if (new Set(required).size !== required.length) fail("duplicate required document ids");
    if (item.category === "cross-document" && new Set(required).size < 2)
      fail("cross-document case requires at least two documents");
    for (const id of required)
      if (!item.relevantChunkIds.some((chunkId) => chunks.get(chunkId)?.documentId === id))
        fail(`required document ${id} has no relevant chunk`);
    if (item.category === "injection" && !item.forbiddenInAnswer?.length)
      fail("injection case requires marker labels");
    if (item.forbiddenInAnswer?.some((marker) => !marker.trim())) fail("empty forbidden marker");
  }
  if (!dataset.some((c) => c.expectRefusal && (c.refusalStage ?? "retrieval") === "retrieval"))
    violations.push("missing retrieval-stage negative cases");
  if (!dataset.some((c) => c.expectRefusal && c.refusalStage === "generation"))
    violations.push("missing generation-stage negative cases (unmeasured offline)");
  return violations;
}

export function collectViolations(
  overall: Record<string, number>,
  perCategory: Record<string, Record<string, number>>,
): string[] {
  const t = thresholds as unknown as Record<string, number> & {
    per_category?: Record<string, Record<string, number>>;
  };
  const violations: string[] = [];
  const validMetric = (name: string, value: number | undefined): value is number => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      violations.push(`${name} must be a finite number between 0 and 1`);
      return false;
    }
    return true;
  };
  const validCount = (name: string, value: number | undefined, minimum: number) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
      violations.push(`${name} must be an integer >= ${minimum}`);
      return false;
    }
    return true;
  };
  validCount("cases", overall["cases"], thresholds.cases_min);
  validCount("answerable_cases", overall["answerable_cases"], 1);
  validCount("retrieval_negative_cases", overall["retrieval_negative_cases"], 1);
  validCount(
    "generation_negative_cases_unmeasured",
    overall["generation_negative_cases_unmeasured"],
    1,
  );
  if (
    overall["cases"] !==
    (overall["answerable_cases"] ?? NaN) +
      (overall["retrieval_negative_cases"] ?? NaN) +
      (overall["generation_negative_cases_unmeasured"] ?? NaN)
  )
    violations.push("case counts do not sum to overall cases");
  validMetric("precision_at_5", overall["precision_at_5"]);
  const floor = (metric: string, key: string) => {
    const limit = t[key];
    if (typeof limit !== "number") return;
    const value = overall[metric];
    if (!validMetric(metric, value)) return;
    if (value + 1e-9 < limit) {
      violations.push(`${metric} ${value.toFixed(3)} < required ${limit}`);
    }
  };

  floor("recall_at_5", "recall_at_5_min");
  floor("recall_at_10", "recall_at_10_min");
  floor("mrr", "mrr_min");
  floor("ndcg_at_10", "ndcg_at_10_min");
  floor("evidence_precision", "evidence_precision_min");
  floor("evidence_ids_valid", "evidence_ids_valid_min");
  floor("retrieval_refusal_accuracy", "retrieval_refusal_accuracy_min");
  floor("evidence_marker_containment", "evidence_marker_containment_min");
  floor("cross_document_coverage", "cross_document_coverage_min");

  const ceiling = t["false_refusal_rate_max"];
  const falseRefusals = overall["false_refusal_rate"];
  if (
    validMetric("false_refusal_rate", falseRefusals) &&
    typeof ceiling === "number" &&
    falseRefusals > ceiling + 1e-9
  ) {
    violations.push(
      `false_refusal_rate ${(overall["false_refusal_rate"] ?? 0).toFixed(3)} > allowed ${ceiling}`,
    );
  }

  for (const [category, limits] of Object.entries(t.per_category ?? {})) {
    const measured = perCategory[category];
    if (!measured) {
      violations.push(`[${category}] missing required category`);
      continue;
    }
    validCount(`[${category}] cases`, measured["cases"], limits["cases_min"] ?? 1);
    if (category !== "negative") {
      validMetric(`[${category}] recall_at_5`, measured["recall_at_5"]);
      validMetric(`[${category}] mrr`, measured["mrr"]);
    }
    const limit = limits["recall_at_5_min"];
    if (typeof limit === "number" && (measured["recall_at_5"] ?? 0) + 1e-9 < limit) {
      violations.push(
        `[${category}] recall_at_5 ${(measured["recall_at_5"] ?? 0).toFixed(3)} < required ${limit}`,
      );
    }
  }

  if (
    Object.values(perCategory).reduce((sum, metrics) => sum + (metrics["cases"] ?? NaN), 0) !==
    overall["cases"]
  )
    violations.push("category counts do not sum to overall cases");
  for (const category of Object.keys(perCategory))
    if (!CATEGORIES.includes(category as EvalCase["category"]))
      violations.push(`[${category}] unknown result category`);

  return violations;
}

/** True when every occurrence of `marker` in the context is inside <evidence>. */
export function isEnclosedInEvidence(contextBlock: string, marker: string): boolean {
  if (!marker.trim()) return false;
  const haystack = contextBlock.toLowerCase();
  const needle = marker.toLowerCase();
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return true;
    const openedAt = haystack.lastIndexOf("<evidence ", at);
    const closedAt = haystack.lastIndexOf("</evidence>", at);
    if (openedAt === -1 || closedAt > openedAt) return false;
    from = at + needle.length;
  }
}

function format(report: EvalReport): string {
  const lines = [
    "QueryVault offline fixture retrieval evaluation",
    "=".repeat(46),
    `Unmeasured: ${report.unmeasured.join(", ")}.`,
    "",
  ];
  for (const [key, value] of Object.entries(report.overall)) {
    lines.push(`${key.padEnd(24)} ${typeof value === "number" ? value.toFixed(3) : value}`);
  }
  lines.push("", "per category");
  for (const [category, metrics] of Object.entries(report.perCategory)) {
    lines.push(
      `  ${category.padEnd(16)} recall@5 ${metrics["recall_at_5"]?.toFixed(3) ?? "N/A"}  mrr ${metrics["mrr"]?.toFixed(3) ?? "N/A"}  (${metrics["cases"]} cases)`,
    );
  }
  lines.push("", "failing cases");
  const failing = report.cases.filter(
    (c) =>
      (c.expectRefusal && c.refusalStage === "retrieval" && !c.refused) ||
      (!c.expectRefusal && (c.refused || c.recallAt5 < 1)) ||
      !c.crossDocumentSatisfied ||
      !c.evidenceIdsValid ||
      !c.evidenceMarkerContainment,
  );
  if (failing.length === 0) lines.push("  none");
  for (const c of failing) {
    lines.push(`  ${c.id.padEnd(30)} recall@5 ${c.recallAt5.toFixed(2)}  gate=${c.gateReason}`);
  }
  lines.push("", report.passed ? "GATE: PASS" : "GATE: FAIL");
  for (const violation of report.violations) lines.push(`  ✗ ${violation}`);
  return lines.join("\n");
}

// argv[1] uses the platform separator, so on Windows this is
// "...\evaluation\runner.ts". Comparing against a forward-slash path made the
// whole block dead there: no report was printed and `--gate` could never
// exit 1, so a retrieval regression passed silently.
const invokedDirectly =
  typeof process !== "undefined" &&
  process.argv[1]?.replace(/\\/g, "/").includes("evaluation/runner");

if (invokedDirectly) {
  const report = await runEvaluation();
  const asJson = process.argv.includes("--json");
  console.log(asJson ? JSON.stringify(report, null, 2) : format(report));
  if (process.argv.includes("--gate") && !report.passed) process.exit(1);
}
