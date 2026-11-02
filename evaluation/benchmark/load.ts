import { readFile, realpath } from "node:fs/promises";
import { resolve, dirname, relative, isAbsolute, extname } from "node:path";
import { createHash } from "node:crypto";
import { extractDocumentPages } from "../../src/lib/ingestion/document-parser.server";
import { PARSER_VERSION } from "../../src/lib/ingestion/contract";
import { MAX_UPLOAD_BYTES, isSupportedDocument } from "../../src/lib/documents.policy";
import { manifestSchema, readiness, type Manifest } from "./schema";
import type { PageText } from "../../src/lib/chunking";

export const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export const extractionHash = (pages: PageText[]) => sha256(canonical({ parserVersion: PARSER_VERSION, pages }));
export type Loaded = { manifest: Manifest; datasetHash: string; pages: Map<string, PageText[]>; files: Map<string, string>; readiness: string[] };
export async function inside(root: string, file: string): Promise<string> {
  if (isAbsolute(file) || file.includes(":") || file.includes("\\")) throw new Error("UNSAFE_DOCUMENT_PATH");
  const base = await realpath(root), path = await realpath(resolve(base, file));
  const rel = relative(base, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("UNSAFE_DOCUMENT_PATH");
  return path;
}
export async function extractFile(path: string) {
  if (!isSupportedDocument(`document${extname(path)}`, undefined)) throw new Error("UNSUPPORTED_DOCUMENT");
  const bytes = await readFile(path);
  if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES) throw new Error("INVALID_DOCUMENT_SIZE");
  const pages = await extractDocumentPages(bytes, path);
  if (!pages.some(p => p.text.trim())) throw new Error("EMPTY_EXTRACTION");
  return { bytes, pages, sha256: sha256(bytes), extractionSha256: extractionHash(pages) };
}
const normalizedQuestion = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export function validateIntegrity(manifest: Manifest, pages: Map<string, PageText[]>): void {
  const docs = new Set<string>(), ids = new Set<string>();
  for (const doc of manifest.documents) {
    if (docs.has(doc.id)) throw new Error("DUPLICATE_DOCUMENT_ID");
    docs.add(doc.id);
    if (manifest.kind === "real" && doc.provenance.kind !== "owner-supplied") throw new Error("SAMPLE_PROVENANCE_IN_REAL_DATASET");
  }
  for (const q of manifest.questions) {
    if (ids.has(q.id)) throw new Error("DUPLICATE_QUESTION_ID");
    ids.add(q.id);
    for (const s of q.supportingSpans) {
      const page = pages.get(s.documentId)?.find(p => p.page === s.page);
      if (!docs.has(s.documentId) || !page || page.text.slice(s.start, s.end) !== s.quote || s.end > page.text.length)
        throw new Error("SOURCE_SPAN_MISMATCH");
    }
  }
  for (let i = 0; i < manifest.questions.length; i++) {
    const a = manifest.questions[i]!;
    for (const b of manifest.questions.slice(i + 1)) {
      const qa = normalizedQuestion(a.question), qb = normalizedQuestion(b.question);
      if (qa === qb) throw new Error("DUPLICATE_QUESTION_TEXT");
      if (a.split === b.split) continue;
      if (a.leakageGroup === b.leakageGroup) throw new Error("CROSS_SPLIT_LEAKAGE_GROUP");
      const x = new Set(qa.split(" ")), y = new Set(qb.split(" "));
      const overlap = [...x].filter(t => y.has(t)).length;
      if (overlap / new Set([...x, ...y]).size >= 0.8) throw new Error("POSSIBLE_CROSS_SPLIT_PARAPHRASE");
      if (a.supportingSpans.some(s => b.supportingSpans.some(t => s.documentId === t.documentId && s.page === t.page && Math.max(s.start, t.start) < Math.min(s.end, t.end))))
        throw new Error("CROSS_SPLIT_SUPPORT_OVERLAP");
    }
  }
}
export async function loadBenchmark(path: string, requireReady = false): Promise<Loaded> {
  // Validation errors expose field paths, not private input values, in the CLI.
  const manifest = manifestSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const pages = new Map<string, PageText[]>(), files = new Map<string, string>();
  for (const doc of manifest.documents) {
    const file = await inside(dirname(resolve(path)), doc.file);
    const extraction = await extractFile(file);
    if (extraction.sha256 !== doc.sha256 || extraction.extractionSha256 !== doc.extractionSha256) throw new Error("DOCUMENT_OR_EXTRACTION_HASH_MISMATCH");
    pages.set(doc.id, extraction.pages); files.set(doc.id, file);
  }
  validateIntegrity(manifest, pages);
  const pending = readiness(manifest);
  if (requireReady && pending.length) throw new Error("BENCHMARK_NOT_READY");
  return { manifest, datasetHash: sha256(canonical(manifest)), pages, files, readiness: pending };
}
