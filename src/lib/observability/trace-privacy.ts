/** Keep timings, scores and identifiers; document text is opt-in diagnostics. */
export function redactTraceContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactTraceContent);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !/content|snippet|filename|question|answer|prompt|text|preview/i.test(key))
      .map(([key, item]) => [key, redactTraceContent(item)]),
  );
}
