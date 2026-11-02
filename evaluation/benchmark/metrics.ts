import type { PageText } from "../../src/lib/chunking";
import { extractSectionBreadcrumb } from "../../src/lib/retrieval/context-builder";
import { recallAtK, reciprocalRank, ndcgAtK } from "../metrics";
import type { Question, Span } from "./schema";

export type Measurement = { status: "measured"; value: number; n: number; method: string } |
  { status: "skipped" | "unavailable" | "unmeasured"; value: null; reason: string; n: number };
export const absent = (status: "skipped" | "unavailable" | "unmeasured", reason: string): Measurement => ({ status, value: null, reason, n: 0 });
export function measured(value: number, method: string, n = 1): Measurement {
  if (!Number.isFinite(value) || value < 0 || value > 1 || !Number.isSafeInteger(n) || n < 1) throw new Error("INVALID_METRIC");
  return { status: "measured", value, method, n };
}
export type LocatedChunk = { chunkId: string; documentId: string; page: number; spans: Span[]; mapping: "exact" | "unavailable" };
function whitespaceMap(text: string) {
  let normalized = ""; const starts: number[] = [], ends: number[] = [];
  for (const match of text.matchAll(/\s+|\S/gu)) {
    normalized += /^\s/.test(match[0]) ? " " : match[0];
    // UTF-16 indices match JavaScript slice, including surrogate pairs.
    for (let j = 0; j < (/^\s/.test(match[0]) ? 1 : match[0].length); j++) {
      starts.push(match.index! + j); ends.push(match.index! + (/^\s/.test(match[0]) ? match[0].length : j + 1));
    }
  }
  return { normalized, starts, ends };
}
export function locate(chunk: { chunkId: string; documentId: string; page: number; content: string }, pages: PageText[]): LocatedChunk {
  const result: LocatedChunk = { chunkId: chunk.chunkId, documentId: chunk.documentId, page: chunk.page, spans: [], mapping: "unavailable" };
  const page = pages.find(p => p.page === chunk.page);
  if (!page) return result;
  const normalized = whitespaceMap(page.text);
  const body = extractSectionBreadcrumb(chunk.content).body;
  const match = (piece: string): Span | null => {
    const needle = piece.replace(/\s+/g, " ").trim();
    if (!needle) return null;
    const at = normalized.normalized.indexOf(needle);
    if (at < 0 || normalized.normalized.indexOf(needle, at + 1) >= 0) return null;
    const start = normalized.starts[at]!, end = normalized.ends[at + needle.length - 1]!;
    return { documentId: chunk.documentId, page: chunk.page, start, end, quote: page.text.slice(start, end) };
  };
  const whole = match(body);
  const parts = whole ? [whole] : body.split(/\n+/).filter(p => p.trim()).map(match);
  result.spans = parts.filter((p): p is Span => p !== null);
  result.mapping = parts.length > 0 && parts.every(Boolean) ? "exact" : "unavailable";
  return result;
}
const intersects = (a: Span, b: Span) => a.documentId === b.documentId && a.page === b.page && Math.max(a.start, b.start) < Math.min(a.end, b.end);
export function spanCoverage(gold: Span[], evidence: Span[]): number {
  if (!gold.length) return 0;
  return gold.filter(s => {
    const parts = evidence.filter(t => intersects(s, t)).sort((a, b) => a.start - b.start);
    let end = s.start;
    for (const p of parts) { if (p.start > end) break; end = Math.max(end, p.end); }
    return end >= s.end;
  }).length / gold.length;
}
export function retrievalMetrics(q: Question, indexed: LocatedChunk[], ranked: LocatedChunk[], context: LocatedChunk[], k = 5): Record<string, Measurement> {
  const names = [`recall_at_${k}`, `precision_at_${k}`, "mrr", `ndcg_at_${k}`, "supporting_document_coverage", "final_context_evidence_coverage", "indexed_evidence_coverage"];
  const missing = !q.answerable ? absent("skipped", "No relevant evidence for negative case") :
    [...indexed, ...ranked, ...context].some(c => c.mapping !== "exact") ? absent("unavailable", "Exact source mapping incomplete or ambiguous") : null;
  if (missing) return Object.fromEntries(names.map(n => [n, missing]));
  const relevant = indexed.filter(c => c.spans.some(s => q.supportingSpans.some(g => intersects(s, g)))).map(c => c.chunkId);
  const ids = ranked.map(c => c.chunkId);
  if (new Set(ids).size !== ids.length) throw new Error("DUPLICATE_RANKED_CHUNK");
  const requiredDocs = new Set(q.supportingSpans.map(s => s.documentId));
  return {
    [`recall_at_${k}`]: measured(relevant.length ? recallAtK(ids, relevant, k) : 0, "Relevant indexed chunks overlapping verified gold spans"),
    [`precision_at_${k}`]: measured(ids.slice(0, k).filter(id => relevant.includes(id)).length / k, "Relevant hits divided by k; missing slots count as misses"),
    mrr: measured(reciprocalRank(ids, relevant), "First relevant indexed chunk"),
    [`ndcg_at_${k}`]: measured(relevant.length ? ndcgAtK(ids, relevant, k) : 0, "Binary relevance from gold span overlap"),
    supporting_document_coverage: measured([...requiredDocs].filter(id => ranked.slice(0, k).some(c => c.documentId === id)).length / requiredDocs.size, `Required documents in top ${k}`),
    final_context_evidence_coverage: measured(spanCoverage(q.supportingSpans, context.flatMap(c => c.spans)), "Gold spans fully covered by delivered context"),
    indexed_evidence_coverage: measured(spanCoverage(q.supportingSpans, indexed.flatMap(c => c.spans)), "Gold spans fully covered after production ingestion"),
  };
}
export const HUMAN_METRICS = ["reference_answer_correctness", "faithfulness", "citation_support", "citation_coverage", "completeness", "relevance"] as const;
export function answerMetrics(q: Question, answer: string | null, refused: boolean | null, requested: boolean): Record<string, Measurement> {
  const state = !requested ? absent("skipped", "Retrieval-only run") : answer === null ? absent("unavailable", "No successful chat response") : absent("unmeasured", "Requires bound human rubric review; no automated judge configured");
  const metrics: Record<string, Measurement> = Object.fromEntries(HUMAN_METRICS.map(name => [name, state]));
  metrics["false_refusal_rate"] = !requested || refused === null ? state : !q.answerable ? absent("skipped", "Negative case") : measured(Number(refused), "Delivered production refusal on answerable case");
  metrics["refusal_accuracy"] = !requested || refused === null ? state : q.answerable ? absent("skipped", "Answerable case") : measured(Number(refused), "Delivered production refusal on negative case");
  // Exact match is supplementary; never substitute it for semantic correctness.
  const normalize = (s: string) => s.replace(/\[source_\d+\]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  metrics["reference_exact_match"] = !requested || answer === null ? state : !q.answerable ? absent("skipped", "Negative case") : measured(Number([q.referenceAnswer, ...q.acceptedAnswers].some(a => normalize(a) === normalize(answer))), "Case/whitespace/citation-normalized exact match only");
  return metrics;
}
export function aggregate(rows: Record<string, Measurement>[]): Record<string, Measurement & { total: number; unavailable: number; unmeasured: number; skipped: number }> {
  const keys = new Set(rows.flatMap(r => Object.keys(r)));
  return Object.fromEntries([...keys].map(key => {
    const values = rows.map(r => r[key] ?? absent("unavailable", "Missing case metric"));
    const actual = values.filter((m): m is Extract<Measurement, {status: "measured"}> => m.status === "measured");
    const counts = { total: rows.length, unavailable: values.filter(m => m.status === "unavailable").length, unmeasured: values.filter(m => m.status === "unmeasured").length, skipped: values.filter(m => m.status === "skipped").length };
    const summary = actual.length ? measured(actual.reduce((s, m) => s + m.value, 0) / actual.length, "Mean of measured cases only; inspect missing counts", actual.length) : absent(counts.unavailable ? "unavailable" : counts.unmeasured ? "unmeasured" : "skipped", "No measured cases");
    return [key, { ...summary, ...counts }];
  }));
}
