import type { ChunkMetadata } from "@/lib/ingestion/contract";

export type PageText = { page: number; text: string };

export type PreparedChunk = {
  content: string;
  page: number;
  index: number;
  metadata?: ChunkMetadata;
};

const SEPARATORS = ["\n\n", "\n", ". ", " ", ""];

/**
 * Finds a clean boundary (sentence terminal, newline, or word boundary)
 * near the target overlap length from the end of the text.
 * Falls back safely to character slicing if no delimiter is found.
 */
export function findBoundaryOverlap(text: string, overlap: number): string {
  if (overlap <= 0 || text.length <= 10) return "";
  const targetLen = Math.min(overlap, text.length);
  // Search within a window around the overlap target (up to 1.6x overlap or text length)
  const maxSearchLen = Math.min(text.length, Math.max(Math.round(overlap * 1.6), overlap + 80));
  const searchSlice = text.slice(text.length - maxSearchLen);

  // 1. Sentence terminal: [.!?]\s+
  const sentenceMatches = [...searchSlice.matchAll(/(?<=[.!?])\s+/g)];
  for (let i = sentenceMatches.length - 1; i >= 0; i--) {
    const m = sentenceMatches[i]!;
    const candidateLen = searchSlice.length - (m.index! + m[0].length);
    if (candidateLen >= Math.round(overlap * 0.4) && candidateLen <= Math.round(overlap * 1.6)) {
      const candidate = searchSlice.slice(m.index! + m[0].length).trim();
      if (candidate.length > 0) return candidate;
    }
  }

  // 2. Paragraph or newline boundary: \n+
  const newlineMatches = [...searchSlice.matchAll(/\n+/g)];
  for (let i = newlineMatches.length - 1; i >= 0; i--) {
    const m = newlineMatches[i]!;
    const candidateLen = searchSlice.length - (m.index! + m[0].length);
    if (candidateLen >= Math.round(overlap * 0.4) && candidateLen <= Math.round(overlap * 1.6)) {
      const candidate = searchSlice.slice(m.index! + m[0].length).trim();
      if (candidate.length > 0) return candidate;
    }
  }

  // 3. Word boundary: \s+
  const wordMatches = [...searchSlice.matchAll(/\s+/g)];
  let bestWordCandidate = "";
  let minDiff = Infinity;
  for (const m of wordMatches) {
    const candidateLen = searchSlice.length - (m.index! + m[0].length);
    if (candidateLen > 0 && candidateLen <= Math.round(overlap * 1.6)) {
      const diff = Math.abs(candidateLen - targetLen);
      if (diff < minDiff) {
        minDiff = diff;
        bestWordCandidate = searchSlice.slice(m.index! + m[0].length).trim();
      }
    }
  }
  if (bestWordCandidate) return bestWordCandidate;

  // 4. Safe fallback: character slice
  return text.slice(-overlap).trim();
}

/**
 * Recursive character text splitter with boundary-snapped sliding window overlap.
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

  // Merge pieces back up to chunkSize with boundary-snapped sliding overlap.
  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (current.length + piece.length <= chunkSize) {
      current += piece;
      continue;
    }
    if (current.trim()) chunks.push(current.trim());
    const tail = overlap > 0 ? findBoundaryOverlap(current, overlap) : "";
    current = tail ? `${tail} ${piece}` : piece;
    while (current.length > chunkSize) {
      // Find clean split point near chunkSize
      let splitAt = chunkSize;
      const windowStart = Math.max(0, chunkSize - 100);
      const searchSub = current.slice(windowStart, chunkSize);
      const spaceIdx = searchSub.lastIndexOf(" ");
      if (spaceIdx > 0) {
        splitAt = windowStart + spaceIdx;
      }
      chunks.push(current.slice(0, splitAt).trim());
      const subTail = overlap > 0 ? findBoundaryOverlap(current.slice(0, splitAt), overlap) : "";
      const remaining = current.slice(splitAt).trim();
      current = subTail ? `${subTail} ${remaining}` : remaining;
      // Guaranteed forward progress
      if (current.length >= splitAt) {
        current = current.slice(Math.max(1, Math.round(chunkSize * 0.4))).trim();
      }
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks.filter((chunk) => chunk.length > 24);
}

/**
 * Checks if a line is a Markdown table row (`| ... |`).
 */
export function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length >= 2;
}

/**
 * Checks if a line is a Markdown table separator (`| --- | :---: |`).
 */
export function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!isTableRow(trimmed)) return false;
  const inner = trimmed.slice(1, -1);
  const cells = inner.split("|");
  return cells.length > 0 && cells.every((cell) => /^[\s:-]+$/.test(cell) && cell.includes("-"));
}

/**
 * Splits Markdown pipe tables along whole row boundaries, keeping small tables atomic
 * and repeating header + separator rows on every chunk for multi-chunk tables.
 */
export function splitTable(tableLines: string[], chunkSize: number): string[] {
  if (tableLines.length <= 2) {
    return [tableLines.join("\n")];
  }

  const headerLines = tableLines.slice(0, 2);
  const dataRows = tableLines.slice(2);
  const fullText = tableLines.join("\n");

  // Keep small tables atomic if they fit inside chunkSize
  if (fullText.length <= chunkSize) {
    return [fullText];
  }

  // Multi-chunk table: split by whole row boundaries and repeat header + separator
  const headerText = headerLines.join("\n");
  const chunks: string[] = [];
  let currentRows: string[] = [];
  let currentLen = headerText.length;

  for (const row of dataRows) {
    // If a single row itself exceeds chunkSize, flush current and emit the row with header
    if (headerText.length + 1 + row.length > chunkSize) {
      if (currentRows.length > 0) {
        chunks.push([headerText, ...currentRows].join("\n"));
        currentRows = [];
        currentLen = headerText.length;
      }
      chunks.push(`${headerText}\n${row}`);
      continue;
    }

    if (currentLen + 1 + row.length <= chunkSize) {
      currentRows.push(row);
      currentLen += 1 + row.length;
    } else {
      if (currentRows.length > 0) {
        chunks.push([headerText, ...currentRows].join("\n"));
      }
      currentRows = [row];
      currentLen = headerText.length + 1 + row.length;
    }
  }

  if (currentRows.length > 0) {
    chunks.push([headerText, ...currentRows].join("\n"));
  }

  return chunks;
}

export type HeadingInfo = {
  level: number;
  title: string;
};

/**
 * Extracts Markdown heading info outside of fenced code blocks.
 */
export function parseHeading(line: string): HeadingInfo | null {
  const match = line.match(/^(#{1,6})\s+(.+)$/);
  if (!match) return null;
  const level = match[1]!.length;
  const title = match[2]!.replace(/\s*#+\s*$/, "").trim();
  return { level, title };
}

/**
 * Converts pages into prepared chunks with boundary-snapped sliding overlap,
 * table preservation, and hierarchical heading breadcrumb tracking.
 */
export function preparePageChunks(
  pages: PageText[],
  chunkSize = 1000,
  overlap = 200,
): PreparedChunk[] {
  const prepared: PreparedChunk[] = [];
  let globalIndex = 0;
  const breadcrumbStack: HeadingInfo[] = [];

  for (const page of pages) {
    const rawText = page.text.replace(/\r/g, "");
    if (!rawText.trim()) continue;

    const lines = rawText.split("\n");
    let inCodeBlock = false;
    let i = 0;

    while (i < lines.length) {
      const line = lines[i]!;
      const trimmed = line.trim();

      // 1. Fenced Code Block Detection
      if (trimmed.startsWith("```")) {
        const codeLines: string[] = [line];
        inCodeBlock = !inCodeBlock;
        i++;
        while (i < lines.length) {
          const codeLine = lines[i]!;
          codeLines.push(codeLine);
          if (codeLine.trim().startsWith("```")) {
            inCodeBlock = false;
            i++;
            break;
          }
          i++;
        }
        const codeBlockText = codeLines.join("\n");
        const currentBreadcrumbs = breadcrumbStack.map((h) => h.title);
        const prefix =
          currentBreadcrumbs.length > 0 ? `[Section: ${currentBreadcrumbs.join(" > ")}]\n\n` : "";
        const effectiveChunkSize = Math.max(200, chunkSize - prefix.length);

        for (const piece of recursiveSplit(codeBlockText, effectiveChunkSize, overlap)) {
          const content = `${prefix}${piece}`.trim();
          prepared.push({
            content,
            page: page.page,
            index: globalIndex++,
            metadata: {
              section: currentBreadcrumbs[currentBreadcrumbs.length - 1],
              breadcrumbs: [...currentBreadcrumbs],
              isTable: false,
              pageNumber: page.page,
            },
          });
        }
        continue;
      }

      // 2. Markdown Heading Hierarchy (outside code blocks)
      const heading = parseHeading(line);
      if (heading) {
        while (
          breadcrumbStack.length > 0 &&
          breadcrumbStack[breadcrumbStack.length - 1]!.level >= heading.level
        ) {
          breadcrumbStack.pop();
        }
        breadcrumbStack.push(heading);
        i++;
        continue;
      }

      // 3. Markdown Pipe-Table Detection (outside code blocks)
      if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
        const tableLines: string[] = [line, lines[i + 1]!];
        i += 2;
        while (i < lines.length && isTableRow(lines[i]!)) {
          tableLines.push(lines[i]!);
          i++;
        }

        const currentBreadcrumbs = breadcrumbStack.map((h) => h.title);
        const prefix =
          currentBreadcrumbs.length > 0 ? `[Section: ${currentBreadcrumbs.join(" > ")}]\n\n` : "";
        const effectiveChunkSize = Math.max(200, chunkSize - prefix.length);

        for (const tableChunk of splitTable(tableLines, effectiveChunkSize)) {
          const content = `${prefix}${tableChunk}`.trim();
          prepared.push({
            content,
            page: page.page,
            index: globalIndex++,
            metadata: {
              section: currentBreadcrumbs[currentBreadcrumbs.length - 1],
              breadcrumbs: [...currentBreadcrumbs],
              isTable: true,
              pageNumber: page.page,
            },
          });
        }
        continue;
      }

      // 4. Regular Text Paragraphs
      const textLines: string[] = [line];
      i++;
      while (i < lines.length) {
        const nextLine = lines[i]!;
        const nextTrimmed = nextLine.trim();
        if (
          nextTrimmed.startsWith("```") ||
          parseHeading(nextLine) ||
          (isTableRow(nextLine) && i + 1 < lines.length && isTableSeparator(lines[i + 1]!))
        ) {
          break;
        }
        textLines.push(nextLine);
        i++;
      }

      const textBlock = textLines
        .join("\n")
        .replace(/[ \t]+/g, " ")
        .trim();

      if (!textBlock) continue;

      const currentBreadcrumbs = breadcrumbStack.map((h) => h.title);
      const prefix =
        currentBreadcrumbs.length > 0 ? `[Section: ${currentBreadcrumbs.join(" > ")}]\n\n` : "";
      const effectiveChunkSize = Math.max(200, chunkSize - prefix.length);

      for (const piece of recursiveSplit(textBlock, effectiveChunkSize, overlap)) {
        const content = `${prefix}${piece}`.trim();
        prepared.push({
          content,
          page: page.page,
          index: globalIndex++,
          metadata: {
            section: currentBreadcrumbs[currentBreadcrumbs.length - 1],
            breadcrumbs: [...currentBreadcrumbs],
            isTable: false,
            pageNumber: page.page,
          },
        });
      }
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
