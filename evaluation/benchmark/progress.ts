import { loadBenchmark } from "./load";
import { categories, TARGETS } from "./schema";

// Load and verify first: invalid drafts never produce a success/count report.
// Deliberately allowlist output; no manifest text, paths or identities escape.
export async function benchmarkProgress(path: string) {
  const loaded = await loadBenchmark(path);
  const { documents, questions } = loaded.manifest;
  const reviews = (records: typeof documents | typeof questions) => ({
    total: records.length,
    reviewedAttestations: records.filter((r) => r.review.status === "reviewed").length,
    pending: records.filter((r) => r.review.status === "pending").length,
    changesRequested: records.filter((r) => r.review.decision === "changes-requested").length,
  });
  return {
    reportVersion: 1,
    scope: "local-benchmark-collection-progress",
    datasetHash: loaded.datasetHash,
    datasetKind: loaded.manifest.kind,
    draftValidity: "valid",
    datasetReadiness: loaded.readiness.length ? "not-ready" : "ready",
    readinessIssues: loaded.readiness,
    counts: {
      documents: documents.length,
      questions: questions.length,
      questionTarget: 60,
      evidenceSpans: questions.reduce((sum, q) => sum + q.supportingSpans.length, 0),
      questionsWithEvidence: questions.filter((q) => q.supportingSpans.length > 0).length,
      providerUseAllowedDocuments: documents.filter((d) => d.provenance.providerUseAllowed).length,
      categories: Object.fromEntries(
        categories.map((category) => [
          category,
          {
            total: questions.filter((q) => q.category === category).length,
            target: TARGETS[category],
            development: questions.filter(
              (q) => q.category === category && q.split === "development",
            ).length,
            heldOut: questions.filter((q) => q.category === category && q.split === "held-out")
              .length,
          },
        ]),
      ),
      splits: {
        development: {
          total: questions.filter((q) => q.split === "development").length,
          target: 40,
        },
        heldOut: { total: questions.filter((q) => q.split === "held-out").length, target: 20 },
      },
      reviews: { documents: reviews(documents), questions: reviews(questions) },
    },
    limitations: {
      semanticAnswerSupport: "not-established-by-automated-validation",
      reviewerIdentity: "not-authenticated",
      liveEnvironmentReadiness: "not-checked",
      liveEvaluation: "not-run",
    },
  };
}
