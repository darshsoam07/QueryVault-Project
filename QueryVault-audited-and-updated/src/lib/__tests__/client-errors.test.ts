import { describe, expect, it } from "vitest";

import { ClientError, fromQueryError, parseApiEnvelope, userMessage } from "@/lib/client-errors";

/**
 * These tests exist to protect one invariant: raw database text must never
 * become user-visible text. A regression here is an information disclosure bug,
 * not a cosmetic one, so the assertions are about what is ABSENT from the
 * output as much as what is present.
 */

/** A realistic PostgREST error for an RLS denial. */
const rlsDenial = {
  code: "42501",
  message: 'new row violates row-level security policy for table "documents"',
  details: null,
  hint: null,
};

/** A realistic PostgREST error naming a constraint. */
const uniqueViolation = {
  code: "23505",
  message: 'duplicate key value violates unique constraint "documents_user_id_content_hash_key"',
  details: "Key (user_id, content_hash)=(a1b2, ff00) already exists.",
  hint: null,
};

describe("fromQueryError", () => {
  it("maps an RLS denial to an authorization message without leaking the table name", () => {
    const error = fromQueryError(rlsDenial, "Could not load your documents.");

    expect(error).toBeInstanceOf(ClientError);
    expect(error.code).toBe("FORBIDDEN");
    expect(error.message).toBe("You do not have access to that.");
    expect(error.message).not.toContain("documents");
    expect(error.message).not.toContain("row-level security");
  });

  it("maps a unique violation without leaking the constraint or key values", () => {
    const error = fromQueryError(uniqueViolation, "Could not save that.");

    expect(error.code).toBe("DUPLICATE");
    expect(error.message).toBe("That already exists.");
    expect(error.message).not.toContain("documents_user_id_content_hash_key");
    expect(error.message).not.toContain("content_hash");
  });

  it("falls back to the operation description for an unmapped code", () => {
    const error = fromQueryError(
      {
        code: "XX999",
        message: "internal error: btree index corrupted",
        details: null,
        hint: null,
      },
      "Could not load your documents.",
    );

    // The fallback is product language, never the provider's text.
    expect(error.message).toBe("Could not load your documents.");
    expect(error.message).not.toContain("btree");
    expect(error.code).toBe("XX999");
  });

  it("survives a null error (Supabase returns null data with no error object)", () => {
    const error = fromQueryError(null, "Could not start a conversation.");
    expect(error.message).toBe("Could not start a conversation.");
    expect(error.code).toBe("INTERNAL");
  });

  it("reports a missing table as a configuration problem, not a user error", () => {
    const error = fromQueryError(
      { code: "PGRST205", message: "Could not find the table 'public.documents'", details: null },
      "Could not load your documents.",
    );
    expect(error.code).toBe("NOT_CONFIGURED");
    expect(error.message).not.toContain("public.documents");
  });
});

describe("userMessage", () => {
  it("passes a curated ClientError through unchanged", () => {
    const error = new ClientError("NOT_FOUND", "That item no longer exists.");
    expect(userMessage(error, "fallback")).toBe("That item no longer exists.");
  });

  it("sanitizes a raw query error that reaches a toast handler directly", () => {
    // This is the defence-in-depth path: even if a call site forgets
    // fromQueryError, the raw text must not render.
    expect(userMessage(rlsDenial, "Could not delete that conversation.")).toBe(
      "You do not have access to that.",
    );
  });

  it("passes a curated server-function ApiError message through", () => {
    // createServerFn errors arrive as a plain Error carrying ApiError's message,
    // which is already written for a user.
    expect(userMessage(new Error("This file is already in your vault."), "fallback")).toBe(
      "This file is already in your vault.",
    );
  });

  it("unwraps our API error envelope instead of rendering JSON at the user", () => {
    const body = JSON.stringify({
      error: {
        code: "RATE_LIMITED",
        message: "Too many questions. Wait a moment.",
        request_id: "qv_abc123",
      },
    });
    expect(userMessage(new Error(body), "fallback")).toBe("Too many questions. Wait a moment.");
    expect(userMessage(body, "fallback")).toBe("Too many questions. Wait a moment.");
  });

  it("uses the fallback for a thrown non-error value", () => {
    expect(userMessage(undefined, "Could not open a conversation.")).toBe(
      "Could not open a conversation.",
    );
    expect(userMessage({}, "Could not open a conversation.")).toBe(
      "Could not open a conversation.",
    );
  });
});

describe("parseApiEnvelope", () => {
  it("returns null for text that is not our envelope", () => {
    expect(parseApiEnvelope("Internal Server Error")).toBeNull();
    expect(parseApiEnvelope("")).toBeNull();
    expect(parseApiEnvelope("{ not json")).toBeNull();
    expect(parseApiEnvelope(JSON.stringify({ message: "no error key" }))).toBeNull();
  });

  it("extracts code, message and request id", () => {
    const parsed = parseApiEnvelope(
      JSON.stringify({
        error: { code: "AI_UNAVAILABLE", message: "The AI service failed.", request_id: "qv_x" },
      }),
    );
    expect(parsed).toEqual({
      code: "AI_UNAVAILABLE",
      message: "The AI service failed.",
      requestId: "qv_x",
    });
  });
});
