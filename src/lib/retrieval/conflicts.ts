import type { EvidenceSource } from "./types";
export type Conflict = {
  left: EvidenceSource;
  right: EvidenceSource;
  leftStatement: string;
  rightStatement: string;
};
/** Narrow, local check: repeated named numeric/date fields in different
 * documents. Different labels/years and unrelated values are not equated.
 * This detects disagreements, never selects which version is authoritative. */
export function findConflicts(question: string, sources: EvidenceSource[]): Conflict[] {
  const fields = new Map<
    string,
    { source: EvidenceSource; value: string; unit: string; statement: string }
  >();
  const result: Conflict[] = [];
  for (const source of sources) {
    for (const statement of source.snippet.split(/\n|(?<=[.!?])\s+/)) {
      const match =
        /^(?:The\s+)?([a-z][a-z0-9 ()/_-]{2,70}?)\s*(?::|=|\bis\b|\bare\b)\s*(\$?\d[\d.,]*(?:\s*(?:days?|months?|years?|percent|%|USD|EUR|dollars?))?|\d{4}-\d{2}-\d{2})[.]?$/i.exec(
          statement.trim(),
        );
      if (!match) continue;
      const key = match[1]!.trim().toLowerCase().replace(/\s+/g, " ");
      if (
        !key.split(/\W+/).some((word) => word.length > 2 && question.toLowerCase().includes(word))
      )
        continue;
      const rawValue = match[2]!.trim().toLowerCase().replace(/\s+/g, " ").replace(/\.$/, "");
      const date = /^\d{4}-\d{2}-\d{2}$/.test(rawValue);
      const number = Number(
        rawValue
          .replace(/^\$/, "")
          .match(/^[\d.,]+/)?.[0]
          ?.replace(/,/g, ""),
      );
      const unit = date
        ? "date"
        : rawValue
            .replace(/^\$?[\d.,]+\s*/, "")
            .replace(/s$/, "")
            .replace("percent", "%")
            .replace("dollar", "usd") || (rawValue.startsWith("$") ? "usd" : "number");
      const value = date ? rawValue : String(number);
      const previous = fields.get(key);
      if (
        previous &&
        previous.source.documentId !== source.documentId &&
        previous.unit === unit &&
        previous.value !== value
      )
        result.push({
          left: previous.source,
          right: source,
          leftStatement: previous.statement,
          rightStatement: statement.trim(),
        });
      else if (!previous) fields.set(key, { source, value, unit, statement: statement.trim() });
    }
  }
  return result.slice(0, 3);
}
export function conflictAnswer(conflicts: Conflict[]): string | null {
  if (!conflicts.length) return null;
  return conflicts
    .map(
      (item) =>
        `The retrieved documents contain differing statements: "${item.leftStatement}" [${item.left.sourceId}] versus "${item.rightStatement}" [${item.right.sourceId}].`,
    )
    .join("\n\n");
}
export function unsupportedCompletenessClaim(answer: string): boolean {
  return /\b(all (?:the )?documents agree|no (?:conflicts|contradictions)|comprehensive summary|complete summary of (?:the |all )?documents)\b/i.test(
    answer,
  );
}
export function summaryQuestion(question: string): boolean {
  return /\b(summari[sz]e|summary|overview|key findings)\b/i.test(question);
}
