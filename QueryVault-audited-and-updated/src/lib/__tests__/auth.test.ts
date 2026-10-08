/**
 * Authentication boundary and API error-contract tests.
 *
 * These cover the two questions that matter at the edge of the server:
 *
 *   1. Who is asking? — bearer-token verification, and specifically that an
 *      invalid, malformed, expired or deleted-account token is rejected rather
 *      than treated as anonymous-but-allowed.
 *   2. What do we tell them when it goes wrong? — the structured envelope, and
 *      the guarantee that internal exception text and credentials never appear
 *      in a response or a log line.
 *
 * Everything here runs offline. The Supabase SDK is mocked, so no network call
 * and no real project are involved.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, errorBody, errorResponse, logEvent, newRequestId } from "@/lib/api-errors";
import { createSupabaseFetch, isNewSupabaseApiKey } from "@/integrations/supabase/api-key";

// ---------------------------------------------------------------------------
// Supabase SDK mock. `getUser` is the auth server round trip we must not make.
// ---------------------------------------------------------------------------

const getUser = vi.fn();
const createClient = vi.fn(() => ({ auth: { getUser } }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => createClient(...(args as [])),
}));

const PUBLISHABLE = "sb_publishable_test_key_value";
const SERVICE_ROLE = "sb_secret_test_service_role_value";

/** A structurally valid (three-part) JWT. Contents are irrelevant — `getUser` decides. */
const WELL_FORMED_TOKEN = "header.payload.signature";

beforeEach(() => {
  vi.resetModules();
  getUser.mockReset();
  createClient.mockClear();
  process.env["SUPABASE_URL"] = "https://project-ref.supabase.co";
  process.env["SUPABASE_PUBLISHABLE_KEY"] = PUBLISHABLE;
});

afterEach(() => {
  delete process.env["SUPABASE_URL"];
  delete process.env["SUPABASE_PUBLISHABLE_KEY"];
});

async function importVerifier() {
  return import("@/integrations/supabase/verify-token.server");
}

// ---------------------------------------------------------------------------
// Unauthorized access
// ---------------------------------------------------------------------------

describe("bearer token verification — rejecting unauthorized callers", () => {
  it.each([
    ["empty string", ""],
    ["no separators", "notajwt"],
    ["two parts only", "header.payload"],
    ["four parts", "a.b.c.d"],
    ["just dots", ".."],
    ["empty signature", "header.payload."],
    ["empty header", ".payload.signature"],
    ["whitespace only", "   "],
  ])("rejects a malformed token (%s) without contacting the auth server", async (_label, token) => {
    const { verifyAccessToken } = await importVerifier();

    await expect(verifyAccessToken(token)).resolves.toBeNull();
    // The point of the structural pre-check: junk must not cost a round trip,
    // and must not reach the SDK at all.
    expect(getUser).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("rejects a well-formed token the auth server refuses (expired / revoked)", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { message: "invalid JWT" } });
    const { verifyAccessToken } = await importVerifier();

    await expect(verifyAccessToken(WELL_FORMED_TOKEN)).resolves.toBeNull();
    expect(getUser).toHaveBeenCalledOnce();
  });

  it("rejects a token whose account no longer exists", async () => {
    // `getUser` is used precisely so a deleted or banned account fails closed
    // instead of staying valid until token expiry.
    getUser.mockResolvedValue({ data: { user: null }, error: null });
    const { verifyAccessToken } = await importVerifier();

    await expect(verifyAccessToken(WELL_FORMED_TOKEN)).resolves.toBeNull();
  });

  it("never returns a caller when verification fails, so callers cannot fall through", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { message: "nope" } });
    const { userIdFromToken } = await importVerifier();

    await expect(userIdFromToken(WELL_FORMED_TOKEN)).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sign-in (the accepted path)
// ---------------------------------------------------------------------------

describe("bearer token verification — accepting a valid caller", () => {
  it("returns the authenticated user id", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "user-abc" } }, error: null });
    const { verifyAccessToken } = await importVerifier();

    const caller = await verifyAccessToken(WELL_FORMED_TOKEN);
    expect(caller?.userId).toBe("user-abc");
  });

  it("userIdFromToken yields the same identity", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "user-abc" } }, error: null });
    const { userIdFromToken } = await importVerifier();

    await expect(userIdFromToken(WELL_FORMED_TOKEN)).resolves.toBe("user-abc");
  });

  it("builds the client with the PUBLISHABLE key, never the service role key", async () => {
    // This is the load-bearing assertion in this file. A user-scoped client built
    // with the service role key would bypass RLS entirely and every subsequent
    // ownership check would be decoration.
    process.env["SUPABASE_SERVICE_ROLE_KEY"] = SERVICE_ROLE;
    getUser.mockResolvedValue({ data: { user: { id: "user-abc" } }, error: null });

    const { verifyAccessToken } = await importVerifier();
    await verifyAccessToken(WELL_FORMED_TOKEN);

    expect(createClient).toHaveBeenCalledOnce();
    const [url, key] = createClient.mock.calls[0] as unknown as [string, string];
    expect(url).toBe("https://project-ref.supabase.co");
    expect(key).toBe(PUBLISHABLE);
    expect(key).not.toBe(SERVICE_ROLE);
    expect(isNewSupabaseApiKey(key)).toBe(true);
    expect(key.startsWith("sb_secret_")).toBe(false);

    delete process.env["SUPABASE_SERVICE_ROLE_KEY"];
  });

  it("fails loudly when Supabase configuration is absent rather than acting anonymously", async () => {
    delete process.env["SUPABASE_PUBLISHABLE_KEY"];
    getUser.mockResolvedValue({ data: { user: { id: "user-abc" } }, error: null });
    const { verifyAccessToken } = await importVerifier();

    // A misconfigured server must not silently degrade into unauthenticated
    // access; it must refuse to build a client at all.
    await expect(verifyAccessToken(WELL_FORMED_TOKEN)).rejects.toThrow(
      /Missing Supabase environment variable/,
    );
  });
});

// ---------------------------------------------------------------------------
// The header dance that makes RLS evaluate as the user
// ---------------------------------------------------------------------------

describe("user-scoped request headers", () => {
  it("sends the caller's token as Authorization and the publishable key as apikey", async () => {
    const seen: { authorization: string | null; apikey: string | null }[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
      _input: unknown,
      init?: RequestInit,
    ) => {
      const headers = new Headers(init?.headers);
      seen.push({
        authorization: headers.get("Authorization"),
        apikey: headers.get("apikey"),
      });
      return new Response("{}", { status: 200 });
    }) as typeof fetch);

    // Exercise the same wrapper the user-scoped client installs.
    const baseFetch = createSupabaseFetch(PUBLISHABLE);
    const headers = new Headers();
    headers.set("Authorization", `Bearer ${WELL_FORMED_TOKEN}`);
    await baseFetch("https://project-ref.supabase.co/rest/v1/documents", { headers });

    expect(seen[0]?.apikey).toBe(PUBLISHABLE);
    // If this became `Bearer sb_publishable_…`, PostgREST would evaluate
    // auth.uid() as the anonymous role and every user query would return nothing.
    expect(seen[0]?.authorization).toBe(`Bearer ${WELL_FORMED_TOKEN}`);

    fetchSpy.mockRestore();
  });

  it("strips a self-referential Authorization header for new-format keys", async () => {
    const seen: (string | null)[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
      _input: unknown,
      init?: RequestInit,
    ) => {
      seen.push(new Headers(init?.headers).get("Authorization"));
      return new Response("{}", { status: 200 });
    }) as typeof fetch);

    const baseFetch = createSupabaseFetch(PUBLISHABLE);
    const headers = new Headers();
    // supabase-js's default: Authorization mirroring the opaque api key. GoTrue
    // would try to parse it as a JWT and reject the request.
    headers.set("Authorization", `Bearer ${PUBLISHABLE}`);
    await baseFetch("https://project-ref.supabase.co/auth/v1/user", { headers });

    expect(seen[0]).toBeNull();
    fetchSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// API error responses
// ---------------------------------------------------------------------------

describe("API error contract", () => {
  it("maps every declared code to its HTTP status", () => {
    expect(new ApiError("UNAUTHENTICATED", "x").status).toBe(401);
    expect(new ApiError("FORBIDDEN", "x").status).toBe(403);
    expect(new ApiError("INVALID_REQUEST", "x").status).toBe(400);
    expect(new ApiError("DOCUMENT_NOT_FOUND", "x").status).toBe(404);
    expect(new ApiError("RATE_LIMITED", "x").status).toBe(429);
    expect(new ApiError("AI_UNAVAILABLE", "x").status).toBe(503);
  });

  it("returns the documented envelope", async () => {
    const requestId = newRequestId();
    const response = errorResponse(
      new ApiError("DOCUMENT_NOT_FOUND", "Document not found"),
      requestId,
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-request-id")).toBe(requestId);
    await expect(response.json()).resolves.toEqual({
      error: { code: "DOCUMENT_NOT_FOUND", message: "Document not found", request_id: requestId },
    });
  });

  it("converts an unexpected exception into INTERNAL without leaking its text", async () => {
    const leaky = new Error(
      'duplicate key value violates unique constraint "documents_user_id_content_hash_key"',
    );
    const response = errorResponse(leaky, "qv_test");

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INTERNAL");
    // The schema must not travel to the client.
    expect(body.error.message).not.toContain("documents_user_id_content_hash_key");
    expect(body.error.message).not.toContain("constraint");
    expect(body.error.message).toBe("Something went wrong. Please try again.");
  });

  it("does not leak a thrown non-Error value either", async () => {
    const response = errorResponse({ pgCode: "42501", table: "documents" }, "qv_test");
    const text = await response.text();
    expect(text).not.toContain("documents");
    expect(text).not.toContain("42501");
  });

  it("preserves extra headers such as Retry-After on a rate-limit response", async () => {
    const response = errorResponse(new ApiError("RATE_LIMITED", "Slow down."), "qv_test", {
      "retry-after": "42",
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("42");
  });

  it("mints correlation ids in the documented shape, uniquely", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newRequestId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^qv_[a-z0-9]{24}$/);
  });

  it("errorBody is a pure projection of its inputs", () => {
    expect(errorBody("FORBIDDEN", "No.", "qv_x")).toEqual({
      error: { code: "FORBIDDEN", message: "No.", request_id: "qv_x" },
    });
  });
});

// ---------------------------------------------------------------------------
// Log redaction
// ---------------------------------------------------------------------------

describe("log redaction", () => {
  it("drops credential- and content-bearing fields while keeping dimensions", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});

    logEvent("info", "chat.completed", "qv_test", {
      userId: "user-abc",
      documentCount: 3,
      // Every one of these must be dropped.
      accessToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig",
      refreshToken: "refresh-me",
      serviceRoleKey: "sb_secret_leak",
      apiKey: "sk-proj-leak",
      password: "hunter2",
      authorization: "Bearer leak",
      question: "What is in my private contract?",
      chunkContent: "CONFIDENTIAL: acquisition price is …",
      promptText: "system prompt",
    });

    expect(spy).toHaveBeenCalledOnce();
    const line = spy.mock.calls[0]![0] as string;

    // Dimensions survive — logs stay useful.
    expect(line).toContain("chat.completed");
    expect(line).toContain("user-abc");
    expect(line).toContain("qv_test");

    for (const secret of [
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      "refresh-me",
      "sb_secret_leak",
      "sk-proj-leak",
      "hunter2",
      "Bearer leak",
      "private contract",
      "acquisition price",
      "system prompt",
    ]) {
      expect(line).not.toContain(secret);
    }

    spy.mockRestore();
  });

  it("routes by level so errors are not buried in stdout", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    logEvent("info", "a", "qv_1");
    logEvent("warn", "b", "qv_2");
    logEvent("error", "c", "qv_3");

    expect(info).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();

    info.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });
});
