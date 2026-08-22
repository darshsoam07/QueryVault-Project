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
  citationsValid: boolean;
  injectionSafe: boolean;
  crossDocumentSatisfied: boolean;
  gateReason: string;
};

/**
 * Simulates a well-behaved model: it cites exactly the evidence ids it was
 * given. That isolates retrieval quality from model variance — generation-side
 * citation validity is enforced separately at runtime in /api/chat.
 */
export async function runCase(evalCase: EvalCase, deps: RetrievalDeps): Promise<CaseResult> {
  const outcome = await runRetrieval(evalCase.question, deps);
  const rankedIds = outcome.ranked.map((candidate) => candidate.chunkId);
  const evidence = outcome.context.sources;
  const evidenceIds = evidence.map((source) => source.chunkId);
  const refused = !outcome.verdict.grounded;

  // Injection defence: adversarial text must reach the model only as quoted,
  // id-tagged evidence — never as bare instruction text. We assert that every
  // forbidden marker present in the context sits inside an <evidence> element
  // and that source ids keep their immutable, model-uncontrollable form.
  const injectionSafe =
    (evalCase.forbiddenInAnswer ?? []).every((marker) =>
      isEnclosedInEvidence(outcome.context.contextBlock, marker),
    ) && evidence.every((source) => /^source_\d{2}$/.test(source.sourceId));

  // A well-behaved model cites the top evidence it was shown; the runtime
  // citation validator rejects anything else, so validity must always hold.
  const simulatedCitations = evidence.slice(0, 3).map((source) => source.sourceId);
  const citationsValid = simulatedCitations.every((id) =>
    evidence.some((source) => source.sourceId === id),
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
    citationsValid,
    injectionSafe,
    crossDocumentSatisfied,
    gateReason: outcome.verdict.reason,
  };
}

export type EvalReport = {
  cases: CaseResult[];
  overall: Record<string, number>;
  perCategory: Record<string, Record<string, number>>;
  violations: string[];
  passed: boolean;
};

export async function runEvaluation(
  deps: RetrievalDeps = createFixtureDeps(),
): Promise<EvalReport> {
  const cases: CaseResult[] = [];
  for (const evalCase of EVAL_CASES) {
    cases.push(await runCase(evalCase, deps));
  }

  const answerable = cases.filter((c) => !c.expectRefusal);
  const gateNegatives = cases.filter((c) => c.expectRefusal && c.refusalStage === "retrieval");
  const injectionCases = cases.filter((c) => c.category === "injection");
  const crossDocCases = cases.filter((c) => c.category === "cross-document");

  const overall = {
    cases: cases.length,
    recall_at_5: mean(answerable.map((c) => c.recallAt5)),
    recall_at_10: mean(answerable.map((c) => c.recallAt10)),
    precision_at_5: mean(answerable.map((c) => c.precisionAt5)),
    mrr: meanReciprocalRank(answerable.map((c) => c.reciprocalRank)),
    ndcg_at_10: mean(answerable.map((c) => c.ndcgAt10)),
    evidence_precision: mean(answerable.map((c) => c.evidencePrecision)),
    citation_validity: cases.every((c) => c.citationsValid) ? 1 : 0,
    refusal_accuracy: refusalAccuracy(
      gateNegatives.map((c) => ({ refused: c.refused, expectRefusal: true })),
    ),
    false_refusal_rate: falseRefusalRate(cases),
    injection_defense: injectionCases.length
      ? injectionCases.filter((c) => c.injectionSafe).length / injectionCases.length
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
      recall_at_5: mean(subset.map((c) => c.recallAt5)),
      mrr: meanReciprocalRank(subset.map((c) => c.reciprocalRank)),
    };
  }

  const violations = collectViolations(overall, perCategory);
  return { cases, overall, perCategory, violations, passed: violations.length === 0 };
}

export function collectViolations(
  overall: Record<string, number>,
  perCategory: Record<string, Record<string, number>>,
): string[] {
  const t = thresholds as unknown as Record<string, number> & {
    per_category?: Record<string, Record<string, number>>;
  };
  const violations: string[] = [];
  const floor = (metric: string, key: string) => {
    const limit = t[key];
    if (typeof limit !== "number") return;
    const value = overall[metric] ?? 0;
    if (value + 1e-9 < limit) {
      violations.push(`${metric} ${value.toFixed(3)} < required ${limit}`);
    }
  };

  floor("recall_at_5", "recall_at_5_min");
  floor("recall_at_10", "recall_at_10_min");
  floor("mrr", "mrr_min");
  floor("ndcg_at_10", "ndcg_at_10_min");
  floor("evidence_precision", "evidence_precision_min");
  floor("citation_validity", "citation_validity_min");
  floor("refusal_accuracy", "refusal_accuracy_min");
  floor("injection_defense", "injection_defense_min");

  const ceiling = t["false_refusal_rate_max"];
  if (typeof ceiling === "number" && (overall["false_refusal_rate"] ?? 0) > ceiling + 1e-9) {
    violations.push(
      `false_refusal_rate ${(overall["false_refusal_rate"] ?? 0).toFixed(3)} > allowed ${ceiling}`,
    );
  }

  for (const [category, limits] of Object.entries(t.per_category ?? {})) {
    const measured = perCategory[category];
    if (!measured) continue;
    const limit = limits["recall_at_5_min"];
    if (typeof limit === "number" && (measured["recall_at_5"] ?? 0) + 1e-9 < limit) {
      violations.push(
        `[${category}] recall_at_5 ${(measured["recall_at_5"] ?? 0).toFixed(3)} < required ${limit}`,
      );
    }
  }

  return violations;
}

/** True when every occurrence of `marker` in the context is inside <evidence>. */
export function isEnclosedInEvidence(contextBlock: string, marker: string): boolean {
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
  const lines = ["QueryVault retrieval evaluation", "=".repeat(34), ""];
  for (const [key, value] of Object.entries(report.overall)) {
    lines.push(`${key.padEnd(24)} ${typeof value === "number" ? value.toFixed(3) : value}`);
  }
  lines.push("", "per category");
  for (const [category, metrics] of Object.entries(report.perCategory)) {
    lines.push(
      `  ${category.padEnd(16)} recall@5 ${(metrics["recall_at_5"] ?? 0).toFixed(3)}  mrr ${(metrics["mrr"] ?? 0).toFixed(3)}  (${metrics["cases"]} cases)`,
    );
  }
  lines.push("", "failing cases");
  const failing = report.cases.filter(
    (c) =>
      (c.expectRefusal && c.refusalStage === "retrieval" && !c.refused) ||
      (!c.expectRefusal && c.recallAt5 < 1),
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
