import { RETRIEVAL_CONFIG } from "./config";
import type { EvidenceSource, RankedCandidate } from "./types";

/** Rough token estimate; deliberate over-estimation is safer than truncation. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function shingles(text: string): Set<string> {
  const words = text.toLowerCase().replace(/\s+/g, " ").trim().split(" ");
  const set = new Set<string>();
  for (let i = 0; i + 2 < words.length; i += 1) {
    set.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  }
  if (set.size === 0 && words.length > 0) set.add(words.join(" "));
  return set;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

export function formatSourceId(index: number): string {
  return `source_${String(index + 1).padStart(2, "0")}`;
}

export type BuiltContext = {
  sources: EvidenceSource[];
  contextBlock: string;
  contextTokens: number;
  droppedDuplicates: number;
};

/**
 * Turns ranked candidates into the evidence set: strongest first, near-duplicate
 * passages folded away, per-page coverage capped, page/document metadata kept,
 * and the whole thing clamped to a token budget.
 */
export function buildContext(
  candidates: RankedCandidate[],
  options: {
    maxSources?: number;
    maxTokens?: number;
    maxSnippetChars?: number;
    duplicateThreshold?: number;
    maxPerPage?: number;
  } = {},
): BuiltContext {
  const maxSources = options.maxSources ?? RETRIEVAL_CONFIG.finalEvidence;
  const maxTokens = options.maxTokens ?? RETRIEVAL_CONFIG.maxContextTokens;
  const maxSnippetChars = options.maxSnippetChars ?? RETRIEVAL_CONFIG.maxSnippetChars;
  const duplicateThreshold = options.duplicateThreshold ?? RETRIEVAL_CONFIG.duplicateThreshold;
  const maxPerPage = options.maxPerPage ?? RETRIEVAL_CONFIG.maxPerPage;

  const kept: Array<{ candidate: RankedCandidate; snippet: string; fingerprint: Set<string> }> = [];
  const perPage = new Map<string, number>();
  let droppedDuplicates = 0;
  let usedTokens = 0;

  for (const candidate of candidates) {
    if (kept.length >= maxSources) break;

    const pageKey = `${candidate.documentId}:${candidate.page}`;
    if ((perPage.get(pageKey) ?? 0) >= maxPerPage) {
      droppedDuplicates += 1;
      continue;
    }

    const fingerprint = shingles(candidate.content);
    const duplicate = kept.some(
      (entry) => jaccard(entry.fingerprint, fingerprint) >= duplicateThreshold,
    );
    if (duplicate) {
      droppedDuplicates += 1;
      continue;
    }

    const snippet = candidate.content.slice(0, maxSnippetChars).trim();
    const tokens = estimateTokens(snippet) + 24; // header overhead
    if (usedTokens + tokens > maxTokens) {
      if (kept.length === 0) {
        // Always keep at least the strongest passage, trimmed to fit.
        const room = Math.max(200, (maxTokens - 24) * 4);
        const trimmed = candidate.content.slice(0, room).trim();
        kept.push({ candidate, snippet: trimmed, fingerprint });
        usedTokens += estimateTokens(trimmed) + 24;
      }
      break;
    }

    usedTokens += tokens;
    perPage.set(pageKey, (perPage.get(pageKey) ?? 0) + 1);
    kept.push({ candidate, snippet, fingerprint });
  }

  const sources: EvidenceSource[] = kept.map((entry, index) => ({
    sourceId: formatSourceId(index),
    chunkId: entry.candidate.chunkId,
    documentId: entry.candidate.documentId,
    filename: entry.candidate.filename,
    page: entry.candidate.page,
    similarityScore:
      entry.candidate.similarity === null ? null : Number(entry.candidate.similarity.toFixed(4)),
    rerankScore:
      entry.candidate.rerankScore === null ? null : Number(entry.candidate.rerankScore.toFixed(4)),
    snippet: entry.snippet,
  }));

  const contextBlock = kept
    .map(
      (entry, index) =>
        `<evidence id="${formatSourceId(index)}" document="${entry.candidate.filename}" page="${entry.candidate.page}">\n${entry.snippet}\n</evidence>`,
    )
    .join("\n\n");

  return { sources, contextBlock, contextTokens: usedTokens, droppedDuplicates };
}
