import { describe, expect, it } from "vitest";
import {
  CHUNKER_VERSION,
  MAX_ATTEMPTS,
  backoffSeconds,
  classifyError,
  deterministicChunkId,
  isRetryable,
  permanent,
  phaseProgress,
  transient,
  PHASE_SEQUENCE,
} from "@/lib/ingestion/contract";
import { hasPdfMagicBytes } from "@/lib/documents.policy";

describe("failure taxonomy", () => {
  it("treats a malformed PDF as permanent and never retries it", () => {
    const failure = permanent("PDF_MALFORMED", "The PDF could not be parsed.");
    expect(failure.failureClass).toBe("PERMANENT");
    expect(isRetryable(failure, 1)).toBe(false);
  });

  it("retries transient failures until the attempt ceiling", () => {
    const failure = transient("UNEXPECTED", "worker crashed mid-run");
    expect(isRetryable(failure, 1)).toBe(true);
    expect(isRetryable(failure, MAX_ATTEMPTS - 1)).toBe(true);
    expect(isRetryable(failure, MAX_ATTEMPTS)).toBe(false);
  });

  it("classifies upstream status codes", () => {
    expect(classifyError({ status: 429, message: "slow down" }).failureClass).toBe(
      "RESOURCE_LIMIT",
    );
    expect(classifyError({ status: 402, message: "no credits" }).code).toBe("CREDITS_EXHAUSTED");
    expect(classifyError({ status: 503, message: "bad gateway" }).failureClass).toBe("DEPENDENCY");
    expect(classifyError({ status: 400, message: "bad input" }).failureClass).toBe("PERMANENT");
  });

  it("treats an unexplained worker crash as retryable, not fatal", () => {
    const failure = classifyError(new Error("Worker terminated unexpectedly"));
    expect(failure.failureClass).toBe("TRANSIENT");
    expect(isRetryable(failure, 1)).toBe(true);
  });

  it("classifies network timeouts as dependency failures", () => {
    expect(classifyError(new Error("fetch failed")).failureClass).toBe("DEPENDENCY");
  });
});

describe("backoff", () => {
  it("grows exponentially and stays bounded", () => {
    const first = backoffSeconds(1, "TRANSIENT");
    const third = backoffSeconds(3, "TRANSIENT");
    expect(first).toBeGreaterThanOrEqual(5);
    expect(third).toBeGreaterThan(first);
    expect(backoffSeconds(20, "TRANSIENT")).toBeLessThanOrEqual(600 * 1.2 + 1);
  });

  it("backs off harder on rate limits", () => {
    expect(backoffSeconds(1, "RESOURCE_LIMIT")).toBeGreaterThanOrEqual(
      backoffSeconds(1, "TRANSIENT"),
    );
  });
});

describe("idempotency", () => {
  it("derives the same chunk id for the same document, version and index", async () => {
    const doc = "6f1c1b8a-1f0a-4e7f-9f0d-0f4a6f5b2c11";
    const a = await deterministicChunkId(doc, CHUNKER_VERSION, 7);
    const b = await deterministicChunkId(doc, CHUNKER_VERSION, 7);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("separates ids across index, document and chunker version", async () => {
    const doc = "6f1c1b8a-1f0a-4e7f-9f0d-0f4a6f5b2c11";
    const other = "0d2f2a11-2b3c-4d5e-8f90-1a2b3c4d5e6f";
    const base = await deterministicChunkId(doc, CHUNKER_VERSION, 0);
    expect(base).not.toBe(await deterministicChunkId(doc, CHUNKER_VERSION, 1));
    expect(base).not.toBe(await deterministicChunkId(other, CHUNKER_VERSION, 0));
    expect(base).not.toBe(await deterministicChunkId(doc, CHUNKER_VERSION + 1, 0));
  });

  it("a re-run writes over exactly the same ids (no duplicate vectors)", async () => {
    const doc = "6f1c1b8a-1f0a-4e7f-9f0d-0f4a6f5b2c11";
    const run = async () =>
      Promise.all([0, 1, 2, 3].map((i) => deterministicChunkId(doc, CHUNKER_VERSION, i)));
    const first = await run();
    const second = await run();
    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(4);
  });
});

describe("partial writes", () => {
  it("a crash after chunk 2 leaves ids the retry reuses, so the final set is complete", async () => {
    const doc = "6f1c1b8a-1f0a-4e7f-9f0d-0f4a6f5b2c11";
    const all = await Promise.all(
      [0, 1, 2, 3, 4].map((i) => deterministicChunkId(doc, CHUNKER_VERSION, i)),
    );
    const writtenBeforeCrash = new Set(all.slice(0, 3));
    const retryWrites = all; // retry starts over from index 0
    const merged = new Set([...writtenBeforeCrash, ...retryWrites]);
    expect(merged.size).toBe(all.length);
  });
});

describe("PDF validation", () => {
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);

  it("accepts a real PDF header", () => {
    expect(hasPdfMagicBytes(pdf)).toBe(true);
  });

  it("rejects an HTML file renamed to .pdf", () => {
    expect(hasPdfMagicBytes(new TextEncoder().encode("<html><body>hi</body></html>"))).toBe(false);
  });

  it("rejects a truncated / empty file", () => {
    expect(hasPdfMagicBytes(new Uint8Array([0x25, 0x50]))).toBe(false);
    expect(hasPdfMagicBytes(new Uint8Array())).toBe(false);
  });

  it("rejects a PNG masquerading as a PDF", () => {
    expect(hasPdfMagicBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      false,
    );
  });
});

describe("phase reporting", () => {
  it("reports honest ordered steps rather than a fabricated percentage", () => {
    expect(phaseProgress("queued").step).toBe(2);
    expect(phaseProgress("ready").step).toBe(PHASE_SEQUENCE.length);
    expect(phaseProgress("embedding").step).toBeGreaterThan(phaseProgress("parsing").step);
    expect(phaseProgress("failed").step).toBe(0);
  });
});
