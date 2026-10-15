/** A parser position is a page only for formats with real pagination. */
export function evidenceLocator(filename: string, position: number, snippet = ""): string {
  const extension = filename.split(".").pop()?.toLowerCase();
  if (extension === "pdf") return `Page ${position}`;
  if (extension === "pptx") return `Slide ${position}`;
  if (extension === "xlsx")
    return snippet.match(/^Sheet: ([^\n]+)/)?.[0] ?? `Worksheet ${position}`;
  return snippet.match(/^\[Section:\s*([^\]]+)\]/)?.[1] ?? "Evidence excerpt";
}
