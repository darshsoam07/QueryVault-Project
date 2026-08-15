export type PageText = { page: number; text: string };

export type PreparedChunk = {
  content: string;
  page: number;
  index: number;
};

const SEPARATORS = ["\n\n", "\n", ". ", " ", ""];

/**
 * Recursive character text splitter — paragraph, then line, then sentence, then
 * word, then hard character split. Mirrors LangChain's RecursiveCharacterTextSplitter.
 */
export function recursiveSplit(text: string, chunkSize: number, overlap: number): string[] {
  const splitRecursive = (input: string, separators: string[]): string[] => {
    if (input.length <= chunkSize) return input.trim() ? [input] : [];

    const [separator, ...rest] = separators;
    if (separator === undefined) {
      const pieces: string[] = [];
      for (let i = 0; i < input.length; i += chunkSize) {
        pieces.push(input.slice(i, i + chunkSize));
      }
      return pieces;
    }

    const parts = separator === "" ? input.split("") : input.split(separator);
    const out: string[] = [];
    for (const part of parts) {
      const withSep = separator === "" ? part : part + separator;
      if (withSep.length > chunkSize) {
        out.push(...splitRecursive(withSep, rest));
      } else if (withSep.trim()) {
        out.push(withSep);
      }
    }
    return out;
  };

  const pieces = splitRecursive(text, SEPARATORS);

  // Merge pieces back up to chunkSize with a sliding overlap window.
  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (current.length + piece.length <= chunkSize) {
      current += piece;
      continue;
    }
    if (current.trim()) chunks.push(current.trim());
    const tail = overlap > 0 ? current.slice(-overlap) : "";
    current = tail + piece;
    while (current.length > chunkSize) {
      chunks.push(current.slice(0, chunkSize).trim());
      current = current.slice(chunkSize - overlap);
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks.filter((chunk) => chunk.length > 24);
}

export function preparePageChunks(
  pages: PageText[],
  chunkSize = 1000,
  overlap = 200,
): PreparedChunk[] {
  const prepared: PreparedChunk[] = [];
  let index = 0;
  for (const page of pages) {
    const normalized = page.text
      .replace(/\r/g, "")
      .replace(/[ \t]+/g, " ")
      .trim();
    if (!normalized) continue;
    for (const content of recursiveSplit(normalized, chunkSize, overlap)) {
      prepared.push({ content, page: page.page, index });
      index += 1;
    }
  }
  return prepared;
}

export function batchArray<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}
