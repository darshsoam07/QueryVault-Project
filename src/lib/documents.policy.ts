/**
 * Document state machine + upload validation rules.
 * Pure functions only — mirrored by the database trigger `enforce_document_transition`.
 */

export const DOCUMENT_STATES = [
  "uploaded",
  "validating",
  "stored",
  "processing",
  "ready",
  "failed",
  "deleting",
] as const;

export type DocumentState = (typeof DOCUMENT_STATES)[number];

const TRANSITIONS: Record<DocumentState, readonly DocumentState[]> = {
  uploaded: ["validating", "failed", "deleting"],
  validating: ["stored", "failed", "deleting"],
  stored: ["processing", "failed", "deleting"],
  processing: ["ready", "failed", "deleting"],
  ready: ["processing", "deleting"],
  failed: ["validating", "processing", "deleting"],
  deleting: [],
};

export function isDocumentState(value: string): value is DocumentState {
  return (DOCUMENT_STATES as readonly string[]).includes(value);
}

export function canTransition(from: DocumentState, to: DocumentState): boolean {
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}

/** In-flight states that count towards the concurrent ingestion cap. */
export const ACTIVE_STATES: readonly DocumentState[] = [
  "uploaded",
  "validating",
  "stored",
  "processing",
];

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MIN_UPLOAD_BYTES = 100;
export const ALLOWED_CONTENT_TYPES = ["application/pdf", "application/x-pdf"] as const;
export const PDF_MAGIC = "%PDF-";

/** Strips paths/control characters and clamps length. Never trust the browser name. */
export function safeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  const base = (name.split(/[\\/]/).pop() ?? "document.pdf").replace(/[\u0000-\u001f]/g, "");
  const cleaned = base.replace(/[^A-Za-z0-9._ ()-]+/g, "_").trim();

  const withExt = /\.pdf$/i.test(cleaned) ? cleaned : `${cleaned || "document"}.pdf`;
  return withExt.slice(-180);
}

export function isAllowedContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const value = contentType.split(";")[0]!.trim().toLowerCase();
  return (ALLOWED_CONTENT_TYPES as readonly string[]).includes(value);
}

/** Server-side magic-byte check — the browser's MIME type is advisory only. */
export function hasPdfMagicBytes(bytes: Uint8Array): boolean {
  if (bytes.length < PDF_MAGIC.length) return false;
  for (let i = 0; i < PDF_MAGIC.length; i += 1) {
    if (bytes[i] !== PDF_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

export function ownerScopedPath(userId: string, documentId: string): string {
  return `${userId}/${documentId}.pdf`;
}

export function isOwnerScopedPath(path: string, userId: string): boolean {
  return path.startsWith(`${userId}/`) && !path.includes("..");
}

export function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

/** Computes the SHA-256 hex digest of file bytes (browser + worker safe). */
export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const buffer = bytes instanceof Uint8Array ? (bytes.slice().buffer as ArrayBuffer) : bytes;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
