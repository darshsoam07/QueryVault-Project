import { z } from "zod";

export const TARGETS = { factual: 15, semantic: 10, exact: 10, "multi-hop": 10, unanswerable: 10, adversarial: 5 } as const;
export const categories = ["factual", "semantic", "exact", "multi-hop", "unanswerable", "adversarial"] as const;
const text = z.string().trim().min(1);
const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/);
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const reviewSchema = z.object({
  status: z.enum(["pending", "reviewed"]),
  reviewer: text.optional(), reviewedAt: z.string().datetime().optional(), notes: text.optional(),
}).strict().superRefine((r, ctx) => {
  if (r.status === "reviewed" && (!r.reviewer || !r.reviewedAt))
    ctx.addIssue({ code: "custom", message: "Reviewed records require reviewer and timestamp" });
});
export const spanSchema = z.object({
  documentId: id, page: z.number().int().positive(),
  start: z.number().int().nonnegative(), end: z.number().int().positive(), quote: text,
}).strict().refine(s => s.end > s.start, "Span end must exceed start");
export const documentSchema = z.object({
  id, file: text, sha256: digest, extractionSha256: digest,
  provenance: z.object({
    kind: z.enum(["owner-supplied", "sample"]), origin: text,
    permission: text, suppliedBy: text, receivedAt: z.string().datetime(),
    providerUseAllowed: z.boolean(),
  }).strict(),
  review: reviewSchema,
}).strict();
export const questionSchema = z.object({
  id, question: text.max(4000), referenceAnswer: z.string(),
  acceptedAnswers: z.array(text).default([]), gradingNotes: text.optional(),
  category: z.enum(categories), difficulty: z.enum(["easy", "medium", "hard"]),
  split: z.enum(["development", "held-out"]), leakageGroup: id,
  answerable: z.boolean(), expectedRefusal: z.boolean(),
  supportingSpans: z.array(spanSchema), review: reviewSchema,
}).strict().superRefine((q, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  if (q.answerable === q.expectedRefusal) fail("Answerability/refusal labels conflict");
  if ((q.category === "unanswerable") !== !q.answerable) fail("Unanswerable category conflicts with labels");
  if (q.answerable && (!q.referenceAnswer.trim() || !q.supportingSpans.length)) fail("Answerable cases require a reference answer and source spans");
  if (!q.answerable && (q.supportingSpans.length || q.acceptedAnswers.length)) fail("Negative cases cannot have supporting spans or accepted factual answers");
  if (q.category === "multi-hop" && q.supportingSpans.length < 2) fail("Multi-hop cases require at least two supporting spans");
});
export const manifestSchema = z.object({
  schemaVersion: z.literal(1), datasetId: id, version: text,
  kind: z.enum(["real", "sample"]), status: z.enum(["population-pending", "draft", "reviewed"]),
  documents: z.array(documentSchema), questions: z.array(questionSchema),
}).strict();
export type Manifest = z.infer<typeof manifestSchema>;
export type Question = z.infer<typeof questionSchema>;
export type Span = z.infer<typeof spanSchema>;

export function readiness(manifest: Manifest): string[] {
  const issues: string[] = [];
  if (manifest.kind !== "real") issues.push("SAMPLE_ONLY");
  if (manifest.status !== "reviewed") issues.push("DATASET_NOT_REVIEWED");
  if (!manifest.documents.length) issues.push("NO_DOCUMENTS");
  if (manifest.questions.length < 60) issues.push("REQUIRES_60_REVIEWED_QUESTIONS");
  for (const category of categories)
    if (manifest.questions.filter(q => q.category === category).length < TARGETS[category])
      issues.push(`INSUFFICIENT_CATEGORY:${category}`);
  for (const split of ["development", "held-out"])
    if (!manifest.questions.some(q => q.split === split)) issues.push(`MISSING_SPLIT:${split}`);
  if (manifest.documents.some(d => d.provenance.kind !== "owner-supplied" || d.review.status !== "reviewed")) issues.push("DOCUMENT_REVIEW_PENDING");
  if (manifest.questions.some(q => q.review.status !== "reviewed")) issues.push("QUESTION_REVIEW_PENDING");
  return issues;
}
