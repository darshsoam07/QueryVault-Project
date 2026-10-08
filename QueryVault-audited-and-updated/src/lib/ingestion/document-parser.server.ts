/** Server-only local document extraction. OCR is deliberately not hidden here:
 * image-only files need an explicitly configured OCR provider. */
import { permanent } from "./contract";
import { extensionOf } from "@/lib/documents.policy";
import type { PageText } from "@/lib/chunking";

const decoder = new TextDecoder("utf-8", { fatal: false });

function single(text: string): PageText[] {
  return [{ page: 1, text }];
}

function stripHtml(source: string): string {
  return source
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s{2,}/g, " ")
    .trim();
}

async function parsePdf(bytes: Uint8Array): Promise<PageText[]> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  try {
    const pdf = await getDocumentProxy(bytes);
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = Array.isArray(text) ? text : [String(text)];
    return pages.map((value, index) => ({ page: index + 1, text: value ?? "" }));
  } catch {
    throw permanent("PARSE_FAILED", "That PDF could not be read. It may be corrupt or encrypted.");
  }
}

async function parseDocx(bytes: Uint8Array): Promise<PageText[]> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  return single(result.value);
}

async function parseWorkbook(bytes: Uint8Array): Promise<PageText[]> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(bytes, { type: "array" });
  return workbook.SheetNames.map((name, index) => {
    const sheet = workbook.Sheets[name];
    return {
      page: index + 1,
      text: sheet ? `Sheet: ${name}\n${XLSX.utils.sheet_to_csv(sheet)}` : `Sheet: ${name}`,
    };
  });
}

async function parsePptx(bytes: Uint8Array): Promise<PageText[]> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(bytes);
  const slides = Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));
  return Promise.all(
    slides.map(async (path, index) => ({
      page: index + 1,
      text: ((await zip.file(path)?.async("text")) ?? "")
        .replace(/<a:t[^>]*>/g, "")
        .replace(/<\/a:t>/g, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim(),
    })),
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
