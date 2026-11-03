import { z } from "zod";

export const TARGETS = {
  factual: 15,
  semantic: 10,
  exact: 10,
  "multi-hop": 10,
  unanswerable: 10,
  adversarial: 5,
} as const;
export const categories = [
  "factual",
  "semantic",
  "exact",
  "multi-hop",
  "unanswerable",
  "adversarial",
] as const;
const text = z.string().trim().min(1);
// Reject common worksheet markers, not arbitrary real names. This cannot
// authenticate identity or establish the truth of a human attestation.
const attestationText = text.refine(
  (value) =>
    !/^(?:tbd|todo|unknown|placeholder|n\/?a|your[ _-]?name|reviewer|author|replace(?:[ _-].*)?|<[^>]+>)$/i.test(
      value,
    ),
  "Replace placeholder with an actual attestation",
);
const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/);
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const reviewSchema = z
  .object({
    status: z.enum(["pending", "reviewed"]),
    reviewer: attestationText.optional(),
    reviewedAt: z.string().datetime().optional(),
    notes: attestationText.optional(),
    author: attestationText.optional(),
    decision: z.enum(["approved", "changes-requested"]).optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.status === "reviewed" && (!r.reviewer || !r.reviewedAt))
      ctx.addIssue({ code: "custom", message: "Reviewed records require reviewer and timestamp" });
  });
export const datasetReviewSchema = reviewSchema.superRefine((r, ctx) => {
  if (r.status !== "reviewed") return;
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  if (!r.author || !r.notes || r.decision !== "approved")
    fail("Dataset signoff requires author, approval decision and review notes");
  const identity = (value: string) =>
    value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
  if (r.author && r.reviewer && identity(r.author) === identity(r.reviewer))
    fail("Dataset review must be independent of the author");
});
export const spanSchema = z
  .object({
    documentId: id,
    page: z.number().int().positive(),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    quote: z
      .string()
      .min(1)
      .refine((value) => value.trim().length > 0),
  })
  .strict()
  .refine((s) => s.end > s.start, "Span end must exceed start");
export const documentSchema = z
  .object({
    id,
    file: text,
    sha256: digest,
    extractionSha256: digest,
    provenance: z
      .object({
        kind: z.enum(["owner-supplied", "sample"]),
        origin: attestationText,
        permission: attestationText,
        suppliedBy: attestationText,
        receivedAt: z.string().datetime(),
        providerUseAllowed: z.boolean(),
      })
      .strict(),
    review: datasetReviewSchema,
  })
  .strict();
export const questionSchema = z
  .object({
    id,
    question: text.max(4000),
    referenceAnswer: text,
    acceptedAnswers: z.array(text).default([]),
    gradingNotes: text.optional(),
    category: z.enum(categories),
    difficulty: z.enum(["easy", "medium", "hard"]),
    split: z.enum(["development", "held-out"]),
    leakageGroup: id,
    answerable: z.boolean(),
    expectedRefusal: z.boolean(),
    supportingSpans: z.array(spanSchema),
    review: datasetReviewSchema,
  })
  .strict()
  .superRefine((q, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    if (q.answerable === q.expectedRefusal) fail("Answerability/refusal labels conflict");
    if ((q.category === "unanswerable") !== !q.answerable)
      fail("Unanswerable category conflicts with labels");
    if (q.answerable && (!q.referenceAnswer.trim() || !q.supportingSpans.length))
      fail("Answerable cases require a reference answer and source spans");
    const spanIds = q.supportingSpans.map((s) => `${s.documentId}:${s.page}:${s.start}:${s.end}`);
    if (new Set(spanIds).size !== spanIds.length) fail("Duplicate supporting spans");
    if (!q.answerable && (q.supportingSpans.length || q.acceptedAnswers.length))
      fail("Negative cases cannot have supporting spans or accepted factual answers");
    if (q.category === "multi-hop" && q.supportingSpans.length < 2)
      fail("Multi-hop cases require at least two supporting spans");
  });
export const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    datasetId: id,
    version: text,
    kind: z.enum(["real", "sample"]),
    status: z.enum(["population-pending", "draft", "reviewed"]),
    documents: z.array(documentSchema),
    questions: z.array(questionSchema),
  })
  .strict();
export type Manifest = z.infer<typeof manifestSchema>;
export type Question = z.infer<typeof questionSchema>;
export type Span = z.infer<typeof spanSchema>;

export function readiness(manifest: Manifest): string[] {
  const issues: string[] = [];
  if (manifest.kind !== "real") issues.push("SAMPLE_ONLY");
  if (manifest.status !== "reviewed") issues.push("DATASET_NOT_REVIEWED");
  if (!manifest.documents.length) issues.push("NO_DOCUMENTS");
  if (manifest.questions.length !== 60) issues.push("REQUIRES_60_REVIEWED_QUESTIONS");
  for (const category of categories)
    if (manifest.questions.filter((q) => q.category === category).length < TARGETS[category])
      issues.push(`INSUFFICIENT_CATEGORY:${category}`);
  for (const [split, minimum] of [
    ["development", 40],
    ["held-out", 20],
  ] as const) {
    const subset = manifest.questions.filter((q) => q.split === split);
    if (!subset.length) issues.push(`MISSING_SPLIT:${split}`);
    if (subset.length < minimum) issues.push(`INSUFFICIENT_SPLIT:${split}:${minimum}`);
    if (subset.length > minimum) issues.push(`EXCESS_SPLIT:${split}:${minimum}`);
    for (const category of categories)
      if (!subset.some((q) => q.category === category))
        issues.push(`MISSING_SPLIT_CATEGORY:${split}:${category}`);
  }
  if (
    manifest.documents.some(
      (d) => d.provenance.kind !== "owner-supplied" || d.review.status !== "reviewed",
    )
  )
    issues.push("DOCUMENT_REVIEW_PENDING");
  if (manifest.questions.some((q) => q.review.status !== "reviewed"))
    issues.push("QUESTION_REVIEW_PENDING");
  return issues;
}
