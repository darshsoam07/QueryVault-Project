function positiveInteger(value: unknown, fallback: number, ceiling: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= ceiling ? parsed : fallback;
}
export const MAX_BATCH_FILES = positiveInteger(
  import.meta.env?.["VITE_UPLOAD_BATCH_COUNT"],
  20,
  100,
);
export const MAX_BATCH_BYTES = positiveInteger(
  import.meta.env?.["VITE_UPLOAD_BATCH_BYTES"],
  200 * 1024 * 1024,
  100 * 25 * 1024 * 1024,
);
