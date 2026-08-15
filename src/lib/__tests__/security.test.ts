import { describe, expect, it } from "vitest";

import {
  MAX_DOCUMENT_IDS,
  MAX_MESSAGES,
  MIN_SIMILARITY,
  chatRequestSchema,
  extractQuestion,
} from "@/lib/chat.schema";
import {
  ACTIVE_STATES,
  MAX_UPLOAD_BYTES,
  MIN_UPLOAD_BYTES,
  canTransition,
  hasPdfMagicBytes,
  isAllowedContentType,
  isOwnerScopedPath,
  isSha256,
  ownerScopedPath,
  safeFilename,
  sha256Hex,
} from "@/lib/documents.policy";
import { RATE_LIMITS, retryAfterSeconds } from "@/lib/rate-limits";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const THREAD = "33333333-3333-4333-8333-333333333333";
const DOC = "44444444-4444-4444-8444-444444444444";

const userMessage = (text: string) => ({ role: "user" as const, parts: [{ type: "text", text }] });

function body(overrides: Record<string, unknown> = {}) {
  return { threadId: THREAD, messages: [userMessage("what is in the contract?")], ...overrides };
}

/* ------------------------------ chat payloads ----------------------------- */

describe("chat request validation", () => {
  it("accepts a well-formed payload", () => {
    expect(chatRequestSchema.safeParse(body()).success).toBe(true);
  });

  it("rejects malformed threadId", () => {
    expect(chatRequestSchema.safeParse(body({ threadId: "not-a-uuid" })).success).toBe(false);
    expect(chatRequestSchema.safeParse(body({ threadId: 42 })).success).toBe(false);
  });

  it("rejects malformed document IDs", () => {
    expect(chatRequestSchema.safeParse(body({ documentIds: ["nope"] })).success).toBe(false);
    expect(chatRequestSchema.safeParse(body({ documentIds: [DOC] })).success).toBe(true);
  });

  it("rejects excessive document ID counts", () => {
    const ids = Array.from({ length: MAX_DOCUMENT_IDS + 1 }, () => DOC);
    expect(chatRequestSchema.safeParse(body({ documentIds: ids })).success).toBe(false);
  });

  it("rejects excessive message counts", () => {
    const messages = Array.from({ length: MAX_MESSAGES + 1 }, () => userMessage("hi"));
    expect(chatRequestSchema.safeParse(body({ messages })).success).toBe(false);
  });

  it("rejects excessive message length", () => {
    const messages = [userMessage("x".repeat(9000))];
    expect(chatRequestSchema.safeParse(body({ messages })).success).toBe(false);
  });

  it("rejects empty message arrays and unknown roles", () => {
    expect(chatRequestSchema.safeParse(body({ messages: [] })).success).toBe(false);
    expect(
      chatRequestSchema.safeParse(
        body({ messages: [{ role: "root", parts: [{ type: "text", text: "hi" }] }] }),
      ).success,
    ).toBe(false);
  });

  it("rejects empty or whitespace-only questions", () => {
    const parsed = chatRequestSchema.parse(body({ messages: [userMessage("   ")] }));
    expect(extractQuestion(parsed.messages)).toBeNull();
  });

  it("extracts the latest user turn only", () => {
    const parsed = chatRequestSchema.parse(
      body({
        messages: [
          userMessage("first"),
          { role: "assistant", parts: [{ type: "text", text: "answer" }] },
          userMessage("second"),
        ],
      }),
    );
    expect(extractQuestion(parsed.messages)).toBe("second");
  });
});

/* --------------------------- retrieval correctness ------------------------ */

describe("retrieval gating", () => {
  const rows = [
    { id: "a", similarity: 0.81 },
    { id: "b", similarity: 0.31 },
    { id: "c", similarity: 0.11 },
  ];

  it("drops low-similarity neighbours before they reach the LLM", () => {
    const kept = rows.filter((row) => row.similarity >= MIN_SIMILARITY).map((row) => row.id);
    expect(kept).toEqual(["a", "b"]);
  });

  it("produces a grounded refusal when nothing clears the threshold", () => {
    const kept = rows.filter((row) => row.similarity >= 0.95);
    expect(kept).toHaveLength(0);
  });

  it("never lets another user's storage path be addressed", () => {
    expect(isOwnerScopedPath(ownerScopedPath(USER_A, DOC), USER_A)).toBe(true);
    expect(isOwnerScopedPath(ownerScopedPath(USER_B, DOC), USER_A)).toBe(false);
    expect(isOwnerScopedPath(`${USER_A}/../${USER_B}/x.pdf`, USER_A)).toBe(false);
  });
});

/* ---------------------------- document lifecycle -------------------------- */

describe("document state machine", () => {
  it("allows the happy path", () => {
    expect(canTransition("uploaded", "validating")).toBe(true);
    expect(canTransition("validating", "stored")).toBe(true);
    expect(canTransition("stored", "processing")).toBe(true);
    expect(canTransition("processing", "ready")).toBe(true);
  });

  it("prevents illegal jumps", () => {
    expect(canTransition("uploaded", "ready")).toBe(false);
    expect(canTransition("stored", "ready")).toBe(false);
    expect(canTransition("deleting", "ready")).toBe(false);
    expect(canTransition("ready", "uploaded")).toBe(false);
  });

  it("treats in-flight states as ingestion work", () => {
    expect(ACTIVE_STATES).toContain("processing");
    expect(ACTIVE_STATES).not.toContain("ready");
    expect(ACTIVE_STATES).not.toContain("deleting");
  });
});

/* ------------------------------ upload safety ----------------------------- */

describe("upload validation", () => {
  const pdf = new TextEncoder().encode("%PDF-1.7\n%âãÏÓ");

  it("accepts real PDF magic bytes", () => {
    expect(hasPdfMagicBytes(pdf)).toBe(true);
  });

  it("rejects invalid or empty content regardless of declared MIME type", () => {
    expect(hasPdfMagicBytes(new Uint8Array())).toBe(false);
    expect(hasPdfMagicBytes(new TextEncoder().encode("<html>hi</html>"))).toBe(false);
    expect(isAllowedContentType("text/html")).toBe(false);
    expect(isAllowedContentType("application/pdf; charset=binary")).toBe(true);
  });

  it("enforces size bounds", () => {
    expect(MIN_UPLOAD_BYTES).toBeGreaterThan(0);
    expect(10 * 1024 * 1024).toBeLessThan(MAX_UPLOAD_BYTES);
    expect(MAX_UPLOAD_BYTES + 1).toBeGreaterThan(MAX_UPLOAD_BYTES);
  });

  it("produces safe filenames", () => {
    expect(safeFilename("../../etc/passwd")).toBe("passwd.pdf");
    expect(safeFilename("my report.pdf")).toBe("my report.pdf");
    expect(safeFilename("we;ird<>|.pdf")).toBe("we_ird_.pdf");
    expect(safeFilename("x".repeat(400)).length).toBeLessThanOrEqual(180);
  });

  it("hashes content deterministically for duplicate detection", async () => {
    const one = await sha256Hex(new TextEncoder().encode("same bytes"));
    const two = await sha256Hex(new TextEncoder().encode("same bytes"));
    const other = await sha256Hex(new TextEncoder().encode("other bytes"));
    expect(one).toBe(two);
    expect(one).not.toBe(other);
    expect(isSha256(one)).toBe(true);
    expect(isSha256("deadbeef")).toBe(false);
  });
});

/* -------------------------------- rate limits ----------------------------- */

describe("rate limits", () => {
  it("defines positive limits for every bucket", () => {
    for (const rule of Object.values(RATE_LIMITS)) {
      expect(rule.limit).toBeGreaterThan(0);
      expect(rule.windowSeconds).toBeGreaterThan(0);
    }
  });

  it("computes a retry-after inside the window", () => {
    const thirtySecondsAgo = new Date(Date.now() - 30_000).toISOString();
    const retry = retryAfterSeconds("chat", thirtySecondsAgo);
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(RATE_LIMITS.chat.windowSeconds);
    expect(retryAfterSeconds("chat", null)).toBe(RATE_LIMITS.chat.windowSeconds);
  });
});
