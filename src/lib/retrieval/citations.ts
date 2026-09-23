import type { EvidenceSource } from "./types";

export type CitationValidation = {
  /** Answer text with unknown citation markers stripped. */
  text: string;
  /** Source ids the model cited that actually exist in this request's evidence. */
  validCitations: string[];
  /** Citation-shaped markers that referenced nothing real. */
  invalidCitations: string[];
};

const CITATION_PATTERN = /\[\s*(source_\d{1,3})\s*\]/gi;

/**
 * Legacy strip-only citation helpers.
 *
 * NOTE (trust workstream A): the chat route no longer uses these. The
 * authoritative contract is `validateCitedAnswer` in
 * `./citation-validator.ts`, which REJECTS answers with uncited blocks or
 * unknown citations instead of silently stripping markers. These helpers are
 * kept for backwards-compatible callers (e.g. offline evaluation).
 */
export function validateCitations(text: string, sources: EvidenceSource[]): CitationValidation {
  const known = new Set(sources.map((source) => source.sourceId));
  const valid = new Set<string>();
  const invalid = new Set<string>();

  const cleaned = text.replace(CITATION_PATTERN, (match, rawId: string) => {
    const id = rawId.toLowerCase();
    if (known.has(id)) {
      valid.add(id);
      return `[${id}]`;
    }
    invalid.add(id);
    return "";
  });

  return {
    text: cleaned.replace(/[ \t]{2,}/g, " ").trim(),
    validCitations: [...valid].sort(),
    invalidCitations: [...invalid].sort(),
  };
}

/** The sources actually cited, preserving evidence order. */
export function citedSources(
  sources: EvidenceSource[],
  validCitations: string[],
): EvidenceSource[] {
  const cited = new Set(validCitations);
  return sources.filter((source) => cited.has(source.sourceId));
}
