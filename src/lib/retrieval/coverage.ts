/** Explicit comparisons must not silently omit a selected document. Simple
 * questions are free to use only their relevant documents. */
export function hasComparisonCoverage(
  question: string,
  selected: string[] | null,
  evidence: Array<{ documentId: string }>,
): boolean {
  if (!selected || !/\b(compar\w*|contrast\w*|versus|vs|each document)\b/i.test(question))
    return true;
  const represented = new Set(evidence.map((source) => source.documentId));
  return selected.every((id) => represented.has(id));
}
