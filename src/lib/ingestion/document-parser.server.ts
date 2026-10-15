import { validateOfficeArchive } from "./archive-policy.server";
import { hasPdfMagicBytes } from "@/lib/documents.policy";
/** Server-only local document extraction. OCR is deliberately not hidden here:
 * image-only files need an explicitly configured OCR provider. */
import { permanent, IngestionFailure } from "./contract";
import { extensionOf } from "@/lib/documents.policy";
import type { PageText } from "@/lib/chunking";

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
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
  try {
    pdf = await getDocumentProxy(bytes);
    if (pdf.numPages > PARSER_LIMITS.maxPdfPages)
      throw permanent(
        "PARSER_LIMIT",
        "PDFs must contain at most 200 pages. Split this file before uploading.",
      );
    const { text } = await extractText(pdf, { mergePages: false });
    const rawPages = Array.isArray(text) ? text : [String(text)];
    const boundedPages = rawPages.slice(0, PARSER_LIMITS.maxPdfPages);
    let remaining = PARSER_LIMITS.maxTotalChars;
    return boundedPages.map((value, index) => {
      const text = (value ?? "").slice(0, Math.min(PARSER_LIMITS.maxPageChars, remaining));
      remaining -= text.length;
      return { page: index + 1, text };
    });
  } catch (error) {
    if (error instanceof IngestionFailure) throw error;
    throw permanent("PARSE_FAILED", "That PDF could not be read. It may be corrupt or encrypted.");
  } finally {
    if (pdf) await pdf.loadingTask.destroy().catch(() => undefined);
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
  const presentation = await zip.file("ppt/presentation.xml")?.async("text");
  const relationships = await zip.file("ppt/_rels/presentation.xml.rels")?.async("text");
  const targets = new Map<string, string>();
  for (const relation of (relationships ?? "").matchAll(/<Relationship\b([^>]*)>/g)) {
    const id = /\bId=["']([^"']+)["']/.exec(relation[1]!)?.[1];
    const target = /\bTarget=["']([^"']+)["']/.exec(relation[1]!)?.[1];
    const type = /\bType=["']([^"']+)["']/.exec(relation[1]!)?.[1];
    if (id && target && type?.endsWith("/slide") && !/TargetMode=["']External/.test(relation[1]!)) {
      const match = /^(?:\/?ppt\/)?(?:slides\/)(slide\d+\.xml)$/.exec(target);
      if (match) targets.set(id, `ppt/slides/${match[1]}`);
    }
  }
  const order = Array.from(
    (presentation ?? "").matchAll(/<(?:[\w.-]+:)?sldId\b[^>]*\br:id=["']([^"']+)["'][^>]*>/g),
    (match) => targets.get(match[1]!),
  );
  if (!order.length || order.some((path) => !path || !zip.file(path)))
    throw permanent("PARSE_FAILED", "The presentation slide order could not be verified.");
  const slideKeys = order
    .filter((path): path is string => Boolean(path))
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
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&")
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
  if (extension === "pdf") {
    if (!hasPdfMagicBytes(bytes))
      throw permanent("PARSE_FAILED", "That file does not have a valid PDF signature.");
    return parsePdf(bytes);
  }
  if (["docx", "xlsx", "pptx"].includes(extension)) {
    validateOfficeArchive(
      bytes,
      extension === "docx"
        ? "word/document.xml"
        : extension === "xlsx"
          ? "xl/workbook.xml"
          : "ppt/presentation.xml",
    );
  }
  if (extension === "docx") return parseDocx(bytes);
  if (extension === "xlsx") return parseWorkbook(bytes);
  if (extension === "pptx") return parsePptx(bytes);
  if (["png", "jpg", "jpeg", "webp"].includes(extension)) {
    throw permanent(
      "OCR_REQUIRED",
      "Images need an OCR provider. Configure one before uploading image-only files.",
    );
  }
  if (bytes.includes(0))
    throw permanent(
      "BAD_TEXT_ENCODING",
      "Text files must use UTF-8 without binary data. Convert this file before uploading.",
    );
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw permanent(
      "BAD_TEXT_ENCODING",
      "Text files must use UTF-8. Convert this file before uploading.",
    );
  }
  if (["txt", "md", "markdown", "csv", "json"].includes(extension)) return single(text);
  if (["html", "htm"].includes(extension)) return single(stripHtml(text));
  throw permanent("UNSUPPORTED_FORMAT", "This file type is not supported.");
}
