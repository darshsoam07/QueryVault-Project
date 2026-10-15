import {
  extractCanonicalCitations,
  splitAnswerBlocks,
  validateCitedAnswer,
} from "./citation-validator";
import type { EvidenceSource } from "./types";
/** Deterministic preflight shared by runtime and offline answer-safety gate. */
export function checkEvidenceClaims(answer: string, sources: EvidenceSource[]) {
  // Re-scan code contents as prose so unknown/malformed markers cannot hide
  // behind the legacy syntax validator's formatting exemptions.
  if (!validateCitedAnswer(answer.replace(/^\s*(`{3,}|~{3,}).*$/gm, ""), sources).valid)
    return null;
  const blocks = splitAnswerBlocks(answer).filter((block) =>
    /[\p{L}\p{N}]/u.test(block.text.replace(/\[source_\d+\]/g, "")),
  );
  const claims = blocks.map((block) => {
    const ids = extractCanonicalCitations(block.text);
    return {
      claim: block.text,
      evidence: sources
        .filter((source) => ids.includes(source.sourceId))
        .map((source) => ({ id: source.sourceId, text: source.snippet })),
    };
  });
  for (const item of claims) {
    if (!item.evidence.length) return null;
    for (const quote of item.claim.matchAll(
      /\u201c([^\u201d\n]+)\u201d|"([^"\n]+)"|(?<!\p{L})'([^'\n]+)'(?!\p{L})/gu,
    )) {
      const exact = quote[1] ?? quote[2] ?? quote[3]!;
      if (!item.evidence.some((source) => source.text.includes(exact))) return null;
    }
  }
  return claims;
}
