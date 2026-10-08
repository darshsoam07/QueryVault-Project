/** Server-only local document extraction. OCR is deliberately not hidden here:
 * image-only files need an explicitly configured OCR provider. */
import { permanent } from "./contract";
import { extensionOf } from "@/lib/documents.policy";
import type { PageText } from "@/lib/chunking";

const decoder = new TextDecoder("utf-8", { fatal: false });

export const PARSER_LIMITS = {
  maxPdfPages: 200,
  maxPageChars: 25_000,
  maxDocxChars: 500_000,
  maxWorkbookSheets: 20,
  maxSheetChars: 40_000,
  maxPptxSlides: 100,
  maxSlideChars: 20_000,
  maxHtmlChars: 200_000,
  maxTotalChars: 1_000_000,
} as const;

function single(text: string, maxChars: number = PARSER_LIMITS.maxTotalChars): PageText[] {
  return [{ page: 1, text: text.slice(0, maxChars) }];
}

function stripHtml(source: string): string {
  const boundedSource = source.slice(0, PARSER_LIMITS.maxHtmlChars);
  return boundedSource
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, PARSER_LIMITS.maxHtmlChars);
}

async function parsePdf(bytes: Uint8Array): Promise<PageText[]> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  try {
    const pdf = await getDocumentProxy(bytes);
    const { text } = await extractText(pdf, { mergePages: false });
    const rawPages = Array.isArray(text) ? text : [String(text)];
    const boundedPages = rawPages.slice(0, PARSER_LIMITS.maxPdfPages);
    return boundedPages.map((value, index) => ({
      page: index + 1,
      text: (value ?? "").slice(0, PARSER_LIMITS.maxPageChars),
    }));
  } catch {
    throw permanent("PARSE_FAILED", "That PDF could not be read. It may be corrupt or encrypted.");
  }
}

async function parseDocx(bytes: Uint8Array): Promise<PageText[]> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  return single(result.value, PARSER_LIMITS.maxDocxChars);
}

async function parseWorkbook(bytes: Uint8Array): Promise<PageText[]> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(bytes, { type: "array", sheetRows: 500 });
  const sheetNames = workbook.SheetNames.slice(0, PARSER_LIMITS.maxWorkbookSheets);
  if (sheetNames.length === 0) {
    throw permanent("NO_TEXT_LAYER", "The workbook contains no readable sheets.");
  }
  let totalChars = 0;
  const pages: PageText[] = [];

  for (let index = 0; index < sheetNames.length; index++) {
    const name = sheetNames[index]!;
    const sheet = workbook.Sheets[name];
    const csv = sheet ? XLSX.utils.sheet_to_csv(sheet) : "";
    const sheetText = (sheet ? `Sheet: ${name}\n${csv}` : `Sheet: ${name}`).slice(
      0,
      PARSER_LIMITS.maxSheetChars,
    );
    totalChars += sheetText.length;
    pages.push({ page: index + 1, text: sheetText });
    if (totalChars >= PARSER_LIMITS.maxTotalChars) break;
  }
  return pages;
}

async function parsePptx(bytes: Uint8Array): Promise<PageText[]> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(bytes);
  const slideKeys = Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
    .slice(0, PARSER_LIMITS.maxPptxSlides);

  if (slideKeys.length === 0) {
    throw permanent("NO_TEXT_LAYER", "No presentation slides found.");
  }

  return Promise.all(
    slideKeys.map(async (path, index) => {
      const raw = (await zip.file(path)?.async("text")) ?? "";
      const text = raw
        .replace(/<a:t[^>]*>/g, "")
        .replace(/<\/a:t>/g, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim()
        .slice(0, PARSER_LIMITS.maxSlideChars);
      return { page: index + 1, text };
    }),
  );
}

export async function extractDocumentPages(
  bytes: Uint8Array,
  filename: string,
): Promise<PageText[]> {
  const extension = extensionOf(filename);
  if (extension === "pdf") return parsePdf(bytes);
  if (extension === "docx") return parseDocx(bytes);
  if (extension === "xlsx") return parseWorkbook(bytes);
  if (extension === "pptx") return parsePptx(bytes);
  const text = decoder.decode(bytes);
  if (["txt", "md", "markdown", "csv", "json"].includes(extension)) return single(text);
  if (["html", "htm"].includes(extension)) return single(stripHtml(text));
  if (["png", "jpg", "jpeg", "webp"].includes(extension)) {
    throw permanent(
      "OCR_REQUIRED",
      "Images need an OCR provider. Configure one before uploading image-only files.",
    );
  }
  throw permanent("UNSUPPORTED_FORMAT", "This file type is not supported.");
}

