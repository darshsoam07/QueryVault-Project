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

export type ExtractedSection = {
  breadcrumb: string | null;
  cleanText: string;
  section: string | null;
  body: string;
};

/**
 * Extracts hierarchical section breadcrumb (e.g. `[Section: H1 > H2]`) from chunk content,
 * returning the breadcrumb and the stripped body text.
 */
export function extractSectionBreadcrumb(text: string): ExtractedSection {
  const match = /^\[Section:\s*([^\]]+)\]\s*\n\n/i.exec(text);
  if (match) {
    const breadcrumb = match[1]?.trim() ?? null;
    const cleanText = text.slice(match[0].length).trim();
    return { breadcrumb, cleanText, section: breadcrumb, body: cleanText };
  }
  const cleanText = text.trim();
  return { breadcrumb: null, cleanText, section: null, body: cleanText };
}

/**
 * Detects suffix-prefix text overlap between earlierText and laterText cleanly
 * with whitespace tolerance. Returns character length of overlapping prefix in laterText.
 */
export function findTextOverlap(
  earlierText: string,
  laterText: string,
  minChars = 16,
  maxChars = 600,
): number {
  const a = earlierText.trimEnd();
  const b = laterText.trimStart();
  const maxSearch = Math.min(a.length, b.length, maxChars);

  // 1. Exact suffix-prefix match
  for (let len = maxSearch; len >= minChars; len--) {
    const suffix = a.slice(a.length - len);
    if (b.startsWith(suffix)) {
      return len;
    }
  }

  // 2. Whitespace-tolerant match (normalizing consecutive whitespace)
  const normA = a.replace(/\s+/g, " ");
  const normB = b.replace(/\s+/g, " ");
  const normMax = Math.min(normA.length, normB.length, maxChars);

  for (let len = normMax; len >= minChars; len--) {
    const suffix = normA.slice(normA.length - len);
    if (normB.startsWith(suffix)) {
      // Find corresponding character length in original raw b
      let bIdx = 0;
      let normIdx = 0;
      while (bIdx < b.length && normIdx < len) {
        if (/\s/.test(b[bIdx]!) && /\s/.test(suffix[normIdx]!)) {
          while (bIdx < b.length && /\s/.test(b[bIdx]!)) bIdx++;
          while (normIdx < suffix.length && /\s/.test(suffix[normIdx]!)) normIdx++;
        } else {
          bIdx++;
          normIdx++;
        }
      }
      return bIdx;
    }
  }

  return 0;
}

/**
 * Merges two adjoining chunks from the same document in reading order,
 * deduplicating section breadcrumbs and overlapping boundary tokens.
 */
export function compressAdjoiningPassages(
  earlierText: string,
  laterText: string,
  minChars = 16,
): string {
  const earlier = extractSectionBreadcrumb(earlierText);
  const later = extractSectionBreadcrumb(laterText);

  const overlap = findTextOverlap(earlier.cleanText, later.cleanText, minChars);
  let mergedBody: string;
  if (overlap > 0) {
    const remainingLater = later.cleanText.trimStart().slice(overlap).trimStart();
    mergedBody = `${earlier.cleanText.trimEnd()}${remainingLater ? ` ${remainingLater}` : ""}`;
  } else {
    const sep = earlier.cleanText.endsWith("\n") ? "\n" : " ";
    mergedBody = `${earlier.cleanText.trimEnd()}${sep}${later.cleanText.trimStart()}`;
  }

  if (earlier.breadcrumb && later.breadcrumb && earlier.breadcrumb === later.breadcrumb) {
    return `[Section: ${earlier.breadcrumb}]\n\n${mergedBody}`;
  } else if (earlier.breadcrumb && !later.breadcrumb) {
    return `[Section: ${earlier.breadcrumb}]\n\n${mergedBody}`;
  } else if (!earlier.breadcrumb && later.breadcrumb) {
    return `[Section: ${later.breadcrumb}]\n\n${mergedBody}`;
  } else if (earlier.breadcrumb && later.breadcrumb && earlier.breadcrumb !== later.breadcrumb) {
    return `[Section: ${earlier.breadcrumb} → ${later.breadcrumb}]\n\n${mergedBody}`;
  }
  return mergedBody;
}

/**
 * Dynamically adjusts Jaccard duplicate threshold based on rerank/similarity score:
 * - High-scoring candidates (>= 0.75): scales up to 0.92 to preserve distinct high-value claims.
 * - Low-scoring candidates (< 0.50): scales down to 0.70 to shed redundant lower-quality text.
 * - Intermediate candidates: linearly scaled around baseThreshold.
 */
export function computeDynamicJaccardThreshold(
  score: number | null | undefined,
  baseThreshold: number = RETRIEVAL_CONFIG.duplicateThreshold,
): number {
  if (score === null || score === undefined || !Number.isFinite(score)) {
    return baseThreshold;
  }
  const s = Math.max(0, Math.min(1, score));
  if (s >= 0.75) {
    const factor = (s - 0.75) / 0.25;
    return Math.min(0.92, baseThreshold + factor * 0.1);
  }
  if (s < 0.5) {
    const factor = (0.5 - s) / 0.5;
    return Math.max(0.7, baseThreshold - factor * (baseThreshold - 0.7));
  }
  return baseThreshold;
}

export type BuiltContext = {
  sources: EvidenceSource[];
  contextBlock: string;
  contextTokens: number;
  droppedDuplicates: number;
  mergedPassages?: number;
};

type KeptEntry = {
  candidate: RankedCandidate;
  snippet: string;
  fingerprint: Set<string>;
  minChunkIndex: number;
  maxChunkIndex: number;
  chunkIndices: Set<number>;
  documentId: string;
  page: number;
};

/**
 * Turns ranked candidates into the evidence set: strongest first, adjoining chunks
 * merged with overlap compression, near-duplicate passages folded away, per-page
 * coverage capped, page/document metadata kept, and clamped to token budget.
 */
export function buildContext(
  candidates: RankedCandidate[],
  options: {
    maxSources?: number;
    maxTokens?: number;
    maxSnippetChars?: number;
    duplicateThreshold?: number;
    maxPerPage?: number;
    enablePassageCompression?: boolean;
    minOverlapChars?: number;
    dynamicJaccard?: boolean;
  } = {},
): BuiltContext {
  const maxSources = options.maxSources ?? RETRIEVAL_CONFIG.finalEvidence;
  const maxTokens = options.maxTokens ?? RETRIEVAL_CONFIG.maxContextTokens;
  const maxSnippetChars = options.maxSnippetChars ?? RETRIEVAL_CONFIG.maxSnippetChars;
  const duplicateThreshold = options.duplicateThreshold ?? RETRIEVAL_CONFIG.duplicateThreshold;
  const maxPerPage = options.maxPerPage ?? RETRIEVAL_CONFIG.maxPerPage;
  const enablePassageCompression =
    options.enablePassageCompression ?? RETRIEVAL_CONFIG.enablePassageCompression;
  const minOverlapChars = options.minOverlapChars ?? RETRIEVAL_CONFIG.minOverlapChars;
  const dynamicJaccard = options.dynamicJaccard ?? RETRIEVAL_CONFIG.dynamicJaccard;

  const kept: KeptEntry[] = [];
  const perPage = new Map<string, number>();
  let droppedDuplicates = 0;
  let mergedPassages = 0;
  let usedTokens = 0;

  for (const candidate of candidates) {
    if (kept.length >= maxSources) break;

    const chunkIdx = typeof candidate.chunkIndex === "number" ? candidate.chunkIndex : 0;

    // 1. Sliding-Window Passage Compression:
    // Check if candidate adjoins an already kept passage from the same document.
    if (enablePassageCompression && typeof candidate.chunkIndex === "number") {
      const adjoiningEntry = kept.find(
        (entry) =>
          entry.documentId === candidate.documentId &&
          (chunkIdx === entry.minChunkIndex - 1 || chunkIdx === entry.maxChunkIndex + 1),
      );

      if (adjoiningEntry) {
        const isPreceding = chunkIdx === adjoiningEntry.minChunkIndex - 1;
        const merged = isPreceding
          ? compressAdjoiningPassages(candidate.content, adjoiningEntry.snippet, minOverlapChars)
          : compressAdjoiningPassages(adjoiningEntry.snippet, candidate.content, minOverlapChars);

        const cappedSnippet =
          merged.length > maxSnippetChars ? merged.slice(0, maxSnippetChars).trim() : merged;

        const oldTokens = estimateTokens(adjoiningEntry.snippet) + 24;
        const newTokens = estimateTokens(cappedSnippet) + 24;
        const tokenDelta = newTokens - oldTokens;

        if (usedTokens + tokenDelta <= maxTokens) {
          adjoiningEntry.snippet = cappedSnippet;
          adjoiningEntry.fingerprint = shingles(cappedSnippet);
          adjoiningEntry.chunkIndices.add(chunkIdx);
          if (isPreceding) {
            adjoiningEntry.minChunkIndex = chunkIdx;
          } else {
            adjoiningEntry.maxChunkIndex = chunkIdx;
          }
          if (
            candidate.rerankScore !== null &&
            (adjoiningEntry.candidate.rerankScore === null ||
              candidate.rerankScore > adjoiningEntry.candidate.rerankScore)
          ) {
            adjoiningEntry.candidate.rerankScore = candidate.rerankScore;
          }
          usedTokens += tokenDelta;
          mergedPassages += 1;
          continue; // Compressed into adjoining passage
        }
      }
    }

    // 2. Per-page coverage cap
    const pageKey = `${candidate.documentId}:${candidate.page}`;
    if ((perPage.get(pageKey) ?? 0) >= maxPerPage) {
      droppedDuplicates += 1;
      continue;
    }

    // 3. Dynamic near-duplicate Jaccard folding
    const fingerprint = shingles(candidate.content);
    const score = candidate.rerankScore ?? candidate.similarity;
    const threshold = dynamicJaccard
      ? computeDynamicJaccardThreshold(score, duplicateThreshold)
      : duplicateThreshold;

    const duplicate = kept.some((entry) => jaccard(entry.fingerprint, fingerprint) >= threshold);
    if (duplicate) {
      droppedDuplicates += 1;
      continue;
    }

    // 4. Token budget clamp
    const snippet = candidate.content.slice(0, maxSnippetChars).trim();
    const tokens = estimateTokens(snippet) + 24; // header overhead
    if (usedTokens + tokens > maxTokens) {
      if (kept.length === 0) {
        // Always keep at least the strongest passage, trimmed to fit.
        const room = Math.max(200, (maxTokens - 24) * 4);
        const trimmed = candidate.content.slice(0, room).trim();
        kept.push({
          candidate,
          snippet: trimmed,
          fingerprint,
          minChunkIndex: chunkIdx,
          maxChunkIndex: chunkIdx,
          chunkIndices: new Set([chunkIdx]),
          documentId: candidate.documentId,
          page: candidate.page,
        });
        usedTokens += estimateTokens(trimmed) + 24;
      }
      break;
    }

    usedTokens += tokens;
    perPage.set(pageKey, (perPage.get(pageKey) ?? 0) + 1);
    kept.push({
      candidate,
      snippet,
      fingerprint,
      minChunkIndex: chunkIdx,
      maxChunkIndex: chunkIdx,
      chunkIndices: new Set([chunkIdx]),
      documentId: candidate.documentId,
      page: candidate.page,
    });
  }

  const sources: EvidenceSource[] = kept.map((entry, index) => ({
    sourceId: formatSourceId(index),
    chunkId: entry.candidate.chunkId,
    documentId: entry.candidate.documentId,
    filename: entry.candidate.filename,
    page: typeof entry.candidate.page === "number" ? entry.candidate.page : 1,
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

  return {
    sources,
    contextBlock,
    contextTokens: usedTokens,
    droppedDuplicates,
    mergedPassages,
  };
}
