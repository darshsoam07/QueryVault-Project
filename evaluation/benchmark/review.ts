import { z } from "zod";
import { digest, reviewSchema } from "./schema";
import { HUMAN_METRICS, measured, aggregate } from "./metrics";
import { sha256 } from "./load";
import type { Run } from "./run";

const scores = z.object({ reference_answer_correctness: z.number().finite().min(0).max(1), faithfulness: z.number().finite().min(0).max(1), citation_support: z.number().finite().min(0).max(1), citation_coverage: z.number().finite().min(0).max(1), completeness: z.number().finite().min(0).max(1), relevance: z.number().finite().min(0).max(1) }).strict();
const reviewFile = z.object({ schemaVersion: z.literal(1), rubricVersion: z.literal("human-v1"), runId: z.string().uuid(), datasetHash: digest,
  judgments: z.array(z.object({ questionId: z.string(), answerHash: digest, review: reviewSchema, scores, rationale: z.string().trim().min(1), evidenceScope: z.literal("returned-citations-only") }).strict()),
}).strict();
export function applyReviews(run: Run, input: unknown) {
  const review = reviewFile.parse(input);
  if (run.scope !== "isolated-live-chat" || run.runId !== review.runId || run.datasetHash !== review.datasetHash) throw new Error("REVIEW_RUN_MISMATCH");
  const seen = new Set<string>();
  const rows = structuredClone(run.cases);
  for (const judgment of review.judgments) {
    if (seen.has(judgment.questionId)) throw new Error("DUPLICATE_JUDGMENT");
    seen.add(judgment.questionId);
    const row = rows.find(r => r.questionId === judgment.questionId);
    if (!row?.generation || row.answerHash !== judgment.answerHash || sha256(row.generation.answer) !== judgment.answerHash || judgment.review.status !== "reviewed") throw new Error("INVALID_OR_STALE_JUDGMENT");
    for (const metric of HUMAN_METRICS) row.metrics.answer[metric] = measured(judgment.scores[metric], `human-v1; ${judgment.review.reviewer}; returned-citations-only`);
  }
  return { schemaVersion: 1, runId: run.runId, datasetHash: run.datasetHash, rubricVersion: review.rubricVersion,
    scope: "human-review-of-isolated-live-chat", evidenceScope: "returned-citations-only",
    status: seen.size === rows.length ? "fully-reviewed" : "partially-reviewed",
    judgments: review.judgments, answerMetrics: aggregate(rows.map(r => r.metrics.answer)),
  };
}
