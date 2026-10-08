/**
 * Pre-render delivery integration tests — around the ACTUAL /api/chat route.
 *
 * These tests exercise the real route handler (src/routes/api/chat.ts) with
 * mocked boundaries (auth, database, rate limit, retrieval outcome,
 * generation provider, telemetry sinks) but the REAL citation contract:
 * validateCitedAnswer -> planDelivery -> orderCitedSources ->
 * chunkAnswerForEmission, plus the real UI-message-stream emission.
 *
 * What is proven here:
 *  - the raw model candidate is never written to the response before
 *    validation (only the validated/normalized plan text is chunked);
 *  - unknown markers ([source_99]) and uncited candidates never appear in
 *    emitted chunks;
 *  - only validated text or the server-controlled refusal is emitted;
 *  - the exact emitted answer byte-equals the exact persisted answer;
 *  - validation failure persists NO fallback all-sources list (sources: []);
 *  - valid responses carry only actually-cited ids, in first-appearance order;
 *  - generation errors surface the controlled AI_UNAVAILABLE API error and
 *    store/return nothing partial;
 *  - request cancellation is wired into generation via abortSignal;
 *  - cancellation yields 499 with no client chunks, no assistant message, and
 *    no generation call after the abort;
 *  - cancellation-race pre-flight guards at every inter-stage boundary
 *    (post-retrieval, post-persistence, pre-generation, post-generation):
 *    an abort in any window yields 499 with no refusal inserted or emitted
 *    and no generation where generation had not already completed;
 *  - emission is synchronous with no artificial post-validation delays.
 *
 * Safe-data discipline: fixtures are synthetic; no prompts, answers beyond
 * the synthetic fixtures, evidence content, or secrets appear.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GROUNDED_REFUSAL } from "@/lib/chat.schema";
import { EVENTS } from "@/lib/observability/events";
import {
  RETRIEVAL_CONFIG,
  callerCancellationError,
  chunkAnswerForEmission,
  normalizeCitationMarkers,
  type EvidenceSource,
} from "@/lib/retrieval";

// ---------------------------------------------------------------------------
// Mock harness (vi.mock factories are hoisted; mutable state lives here)
// ---------------------------------------------------------------------------

const harness = vi.hoisted(() => {
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  const threadRow = { id: "11111111-1111-1111-8111-111111111111", title: "New chat" };
  type MockBuilder = {
    select: (...args: unknown[]) => MockBuilder;
    eq: (...args: unknown[]) => MockBuilder;
    in: (...args: unknown[]) => MockBuilder;
    update: (...args: unknown[]) => MockBuilder;
    maybeSingle: () => Promise<{ data: { id: string; title: string } | null; error: null }>;
    insert: (row: Record<string, unknown>) => Promise<{ data: null; error: null }>;
    then: (resolve: (v: unknown) => void) => void;
  };
  const makeBuilder = (table: string): MockBuilder => {
    const builder = {} as MockBuilder;
    const chain = (..._args: unknown[]) => builder;
    builder.select = chain;
    builder.eq = chain;
    builder.in = chain;
    builder.update = chain;
    builder.maybeSingle = async () => ({
      data: table === "threads" ? { ...threadRow } : null,
      error: null,
    });
    builder.insert = async (row: Record<string, unknown>) => {
      inserts.push({ table, row });
      return { data: null, error: null };
    };
    // Thenable so `await builder` (update paths) resolves harmlessly.
    builder.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
    return builder;
  };
  return {
    inserts,
    db: { from: (table: string) => makeBuilder(table) },
    reset() {
      inserts.length = 0;
    },
    assistantInserts() {
      return inserts.filter((i) => i.table === "messages" && i.row["role"] === "assistant");
    },
    userInserts() {
      return inserts.filter((i) => i.table === "messages" && i.row["role"] === "user");
    },
  };
});

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  runRetrieval: vi.fn(),
  emitAsync: vi.fn(),
  recordQueryTrace: vi.fn(),
  logEvent: vi.fn(),
  enforceRateLimit: vi.fn(),
  requireAiProvider: vi.fn(),
  verifyAccessToken: vi.fn(),
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: mocks.generateText };
});

vi.mock("@/lib/retrieval", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/retrieval")>();
  return {
    ...actual,
    runRetrieval: mocks.runRetrieval,
    createLiveDeps: (args: unknown) => args,
  };
});

vi.mock("@/lib/ai-gateway.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-gateway.server")>();
  return {
    ...actual,
    requireAiProvider: mocks.requireAiProvider,
    createAiSdkProvider: () => (model: string) => ({ mockModel: model }),
  };
});

vi.mock("@/lib/rate-limit.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit.server")>();
  return { ...actual, enforceRateLimit: mocks.enforceRateLimit };
});

vi.mock("@/lib/observability/telemetry.server", () => ({
  emitAsync: mocks.emitAsync,
  recordQueryTrace: mocks.recordQueryTrace,
}));

vi.mock("@/lib/api-errors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-errors")>();
  return { ...actual, logEvent: mocks.logEvent };
});

vi.mock("@/integrations/supabase/verify-token.server", () => ({
  verifyAccessToken: mocks.verifyAccessToken,
}));

// The real route module under test.
import { Route } from "@/routes/api/chat";

type PostHandler = (ctx: { request: Request }) => Promise<Response>;
const POST = (Route as unknown as { options: { server: { handlers: { POST: PostHandler } } } })
  .options.server.handlers.POST;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const THREAD_ID = "11111111-1111-1111-8111-111111111111";

function evidence(): EvidenceSource[] {
  return [
    {
      sourceId: "source_01",
      chunkId: "chunk-1",
      documentId: "doc-1",
      filename: "a.pdf",
      page: 1,
      similarityScore: 0.9,
      rerankScore: 0.8,
      snippet: "snippet one",
    },
    {
      sourceId: "source_02",
      chunkId: "chunk-2",
      documentId: "doc-2",
      filename: "b.pdf",
      page: 2,
      similarityScore: 0.85,
      rerankScore: 0.7,
      snippet: "snippet two",
    },
  ];
}

function retrievalOutcome(sources: EvidenceSource[], grounded = true) {
  return {
    context: { sources, contextBlock: "CTX" },
    telemetry: {
      retrievalLatencyMs: 5,
      embeddingLatencyMs: 1,
      denseLatencyMs: 1,
      lexicalLatencyMs: 1,
      rerankLatencyMs: 1,
      denseCandidates: 6,
      lexicalCandidates: 6,
      fusedCandidates: 4,
      rerankedCandidates: 4,
      finalEvidence: sources.length,
      bestSimilarity: 0.9,
      bestRerankScore: 0.8,
      rerankerName: "heuristic",
      rerankerFallback: null,
      contextTokens: 100,
      droppedDuplicates: 0,
      queryRewritten: false,
      queryVariants: 1,
    },
    verdict: {
      grounded,
      reason: grounded ? null : "below_threshold",
      bestSimilarity: 0.9,
      bestRerankScore: 0.8,
    },
    ranked: sources.map((s, i) => ({
      chunkId: s.chunkId,
      filename: s.filename,
      page: s.page,
      similarity: s.similarityScore,
      densePosition: i,
      lexicalPosition: i,
      lexicalRank: i + 1,
      fusionScore: 1 - i * 0.1,
      rerankScore: s.rerankScore,
    })),
  };
}

function makeRequest(signal?: AbortSignal): Request {
  const init: RequestInit = {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
      "x-request-id": "req-int-1",
    },
    body: JSON.stringify({
      threadId: THREAD_ID,
      messages: [
        {
          id: "m1",
          role: "user",
          parts: [{ type: "text", text: "What is the notice period?" }],
        },
      ],
      documentIds: [],
    }),
  };
  if (signal) init.signal = signal;
  return new Request("http://localhost/api/chat", init);
}

type StreamPart = { type: string; delta?: unknown; data?: unknown; [key: string]: unknown };

function parseStreamParts(sse: string): StreamPart[] {
  const parts: StreamPart[] = [];
  for (const line of sse.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") continue;
    try {
      parts.push(JSON.parse(payload) as StreamPart);
    } catch {
      // Ignore non-JSON control lines.
    }
  }
  return parts;
}

function emittedText(parts: StreamPart[]): string {
  return parts
    .filter((p) => p.type === "text-delta")
    .map((p) => String(p.delta ?? ""))
    .join("");
}

function dataPart(parts: StreamPart[], type: string): StreamPart | undefined {
  return parts.find((p) => p.type === type);
}

function generationCompletedCalls() {
  return mocks.emitAsync.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .filter((event) => event["event"] === EVENTS.GENERATION_COMPLETED);
}

const fakeProvider = {
  id: "openai-compatible",
  label: "test",
  baseUrl: "http://localhost:1",
  chatModel: "test-model",
  utilityModel: "test-model",
  embeddingModel: "test-embed",
  embeddingDimensions: 3072,
  authHeaders: () => ({}),
};

beforeEach(() => {
  vi.clearAllMocks();
  harness.reset();
  // clearAllMocks preserves implementations; reset emitAsync so a
  // per-test implementation never leaks into a later test.
  mocks.emitAsync.mockReset();
  mocks.requireAiProvider.mockReturnValue(fakeProvider);
  mocks.verifyAccessToken.mockResolvedValue({ supabase: harness.db, userId: "user-1" });
  mocks.enforceRateLimit.mockResolvedValue(undefined);
  // Default retrieval: grounded, signal-aware (throws the caller
  // cancellation error when the request signal aborted, like the real
  // reranker pre-flight path).
  mocks.runRetrieval.mockImplementation(
    async (_question: unknown, deps: { signal?: AbortSignal }) => {
      if (deps?.signal?.aborted) throw callerCancellationError(deps.signal);
      return retrievalOutcome(evidence());
    },
  );
});

// ---------------------------------------------------------------------------
// Delivery: validation happens before anything is rendered or stored
// ---------------------------------------------------------------------------

describe("chat route: pre-render delivery", () => {
  it("emits only the validated (normalized) text; emitted byte-equals persisted; sources are cited-only in first-appearance order", async () => {
    // [source_1] is normalizable: the emitted text must carry the canonical
    // [source_01], proving the VALIDATED text — not the raw candidate — is
    // what reaches the client.
    const candidate = "The notice period is 30 days [source_1]. The fee is waived [source_02].";
    mocks.generateText.mockResolvedValue({ text: candidate });

    const response = await POST({ request: makeRequest() });
    expect(response.status).toBe(200);
    const parts = parseStreamParts(await response.text());
    const text = emittedText(parts);

    expect(text).toBe(normalizeCitationMarkers(candidate));
    expect(text).toContain("[source_01]");
    expect(text).not.toContain("[source_1]");
    // Chunks reassemble the validated answer exactly.
    expect(parts.filter((p) => p.type === "text-delta").length).toBeGreaterThan(0);

    // Sources: only actually-cited ids, in first-appearance order.
    const sourcesPart = dataPart(parts, "data-sources");
    expect(sourcesPart).toBeDefined();
    const emittedSources = (sourcesPart!.data as Array<{ sourceId: string }>).map(
      (s) => s.sourceId,
    );
    expect(emittedSources).toEqual(["source_01", "source_02"]);

    const citationsPart = dataPart(parts, "data-citations");
    expect(citationsPart).toBeDefined();
    expect((citationsPart!.data as { citations: string[] }).citations).toEqual([
      "source_01",
      "source_02",
    ]);

    // Persistence: exactly one assistant message, byte-identical text, the
    // same source payload — never the raw candidate, never all sources.
    const assistant = harness.assistantInserts();
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.row["content"]).toBe(text);
    expect(assistant[0]!.row["sources"]).toEqual(sourcesPart!.data);

    // Validation timing instrumentation is present (safe metadata only).
    const completed = generationCompletedCalls();
    expect(completed).toHaveLength(1);
    const attrs = completed[0]!["attributes"] as Record<string, unknown>;
    expect(attrs["refused"]).toBe(false);
    expect(typeof attrs["validation_latency_ms"]).toBe("number");
    expect(attrs["answer_length"]).toBe(text.length);
    expect(attrs["contract_version"]).toBe("citation-contract/v1");
  });

  it("unknown [source_99] never appears in emitted chunks; server refusal is delivered with no fallback source list", async () => {
    const candidate = "Thirty days [source_01], plus a hidden [source_99] marker.";
    mocks.generateText.mockResolvedValue({ text: candidate });

    const response = await POST({ request: makeRequest() });
    expect(response.status).toBe(200);
    const parts = parseStreamParts(await response.text());
    const text = emittedText(parts);

    // Only the server-controlled refusal leaves the server.
    expect(text).toBe(GROUNDED_REFUSAL);
    expect(text).not.toContain("[source_99]");
    expect(text).not.toContain("[source_01]");
    expect(text).not.toContain("Thirty days");

    // No fabricated or fallback source list: nothing valid was cited.
    const sourcesPart = dataPart(parts, "data-sources");
    expect(sourcesPart).toBeDefined();
    expect(sourcesPart!.data).toEqual([]);

    // Persisted exactly as delivered, with sources: [].
    const assistant = harness.assistantInserts();
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.row["content"]).toBe(GROUNDED_REFUSAL);
    expect(assistant[0]!.row["sources"]).toEqual([]);

    // Telemetry records the validation failure (safe fields only).
    const completed = generationCompletedCalls();
    expect(completed).toHaveLength(1);
    const event = completed[0]!;
    expect(event["status"]).toBe("error");
    expect(event["errorCode"]).toBe("CITATION_VALIDATION_FAILED");
    const attrs = event["attributes"] as Record<string, unknown>;
    expect(attrs["refused"]).toBe(true);
    expect(attrs["citation_failure_reason"]).toBe("unknown_citation");
    expect(attrs["contract_version"]).toBe("citation-contract/v1");

    const validationLog = mocks.logEvent.mock.calls.find(
      (call) => call[1] === "chat.citation_validation_failed",
    );
    expect(validationLog).toBeDefined();
    expect(validationLog![3]).toMatchObject({
      success: false,
      failureReason: "unknown_citation",
      contractVersion: "citation-contract/v1",
    });
  });

  it("an uncited candidate never appears in emitted chunks", async () => {
    const candidate = "The notice period is thirty days, trust me, with no citation at all.";
    mocks.generateText.mockResolvedValue({ text: candidate });

    const response = await POST({ request: makeRequest() });
    const parts = parseStreamParts(await response.text());
    const text = emittedText(parts);

    expect(text).toBe(GROUNDED_REFUSAL);
    expect(text).not.toContain("trust me");

    const assistant = harness.assistantInserts();
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.row["content"]).toBe(GROUNDED_REFUSAL);
    expect(assistant[0]!.row["sources"]).toEqual([]);

    const attrs = generationCompletedCalls()[0]!["attributes"] as Record<string, unknown>;
    expect(attrs["citation_failure_reason"]).toBe("no_citations");
  });

  it("empty/whitespace model output fails closed at route level", async () => {
    mocks.generateText.mockResolvedValue({ text: "   \n  " });

    const response = await POST({ request: makeRequest() });
    const parts = parseStreamParts(await response.text());
    const text = emittedText(parts);

    expect(text).toBe(GROUNDED_REFUSAL);
    const assistant = harness.assistantInserts();
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.row["content"]).toBe(GROUNDED_REFUSAL);

    const attrs = generationCompletedCalls()[0]!["attributes"] as Record<string, unknown>;
    expect(attrs["refused"]).toBe(true);
    expect(attrs["citation_failure_reason"]).toBe("no_citations");
  });

  it("model output byte-identical to the grounded refusal is still validated: the SERVER refusal is delivered and refused:true is recorded", async () => {
    // No string-equality exemption: a model echoing the refusal sentence is
    // uncited prose, so validation fails and the server-selected refusal
    // plan is delivered instead. User-visible text is the same sentence;
    // telemetry must show refused:true + CITATION_VALIDATION_FAILED.
    mocks.generateText.mockResolvedValue({ text: GROUNDED_REFUSAL });

    const response = await POST({ request: makeRequest() });
    const parts = parseStreamParts(await response.text());
    const text = emittedText(parts);

    expect(text).toBe(GROUNDED_REFUSAL);
    const assistant = harness.assistantInserts();
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.row["content"]).toBe(GROUNDED_REFUSAL);
    expect(assistant[0]!.row["sources"]).toEqual([]);

    const completed = generationCompletedCalls();
    expect(completed).toHaveLength(1);
    expect(completed[0]!["status"]).toBe("error");
    expect(completed[0]!["errorCode"]).toBe("CITATION_VALIDATION_FAILED");
    const attrs = completed[0]!["attributes"] as Record<string, unknown>;
    expect(attrs["refused"]).toBe(true);
    expect(attrs["citation_failure_reason"]).toBe("no_citations");
  });
});

// ---------------------------------------------------------------------------
// Buffered generation: failure handling
// ---------------------------------------------------------------------------

describe("chat route: buffered generation failure handling", () => {
  it("generation errors produce the controlled AI_UNAVAILABLE error; nothing partial is stored or returned", async () => {
    mocks.generateText.mockRejectedValue(new Error("provider down"));

    const response = await POST({ request: makeRequest() });
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AI_UNAVAILABLE");

    // Atomic generation: a throw means no text — nothing persisted, no
    // stream body, no partial answer anywhere.
    expect(harness.assistantInserts()).toHaveLength(0);
    const text = await response.text().catch(() => "");
    expect(text).not.toContain("notice period");

    const failed = mocks.emitAsync.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((event) => event["event"] === EVENTS.GENERATION_FAILED);
    expect(failed).toBeDefined();
    expect(failed!["errorCode"]).toBe("AI_UNAVAILABLE");
  });

  it("the request signal is linked into generation: aborting the request aborts the generation signal", async () => {
    let seenSignal: AbortSignal | null = null;
    mocks.generateText.mockImplementation(
      (args: { abortSignal?: AbortSignal }) =>
        new Promise<{ text: string }>((_resolve, reject) => {
          seenSignal = args.abortSignal ?? null;
          // Like a real provider call: reject when the signal aborts.
          const signal = args.abortSignal;
          const onAbort = () =>
            reject(new DOMException("The operation was aborted.", "AbortError"));
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
        }),
    );

    const controller = new AbortController();
    const request = makeRequest(controller.signal);
    const pending = POST({ request });
    // Wait until generation actually started, then drop the client.
    await vi.waitFor(() => expect(mocks.generateText).toHaveBeenCalledTimes(1));
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    // A linked signal now stands between the request and the provider: it is
    // not the raw request signal, but it follows it — aborting the request
    // aborts the in-flight provider call.
    expect(seenSignal).not.toBe(request.signal);
    controller.abort();

    const response = await pending;
    expect(response.status).toBe(499);
    expect(await response.text()).toBe("");
    expect(seenSignal!.aborted).toBe(true);
    expect(harness.assistantInserts()).toHaveLength(0);
  });

  it("no artificial post-validation delays: emission is synchronous", () => {
    // chunkAnswerForEmission must be a pure synchronous splitter — no
    // timers, no promises, no pacing of validated chunks.
    const text = "The notice period is 30 days [source_01]. ".repeat(20).trim();
    const chunks = chunkAnswerForEmission(text);
    expect(Array.isArray(chunks)).toBe(true);
    expect(chunks.join("")).toBe(text);
    expect(chunkAnswerForEmission.toString()).not.toMatch(
      /setTimeout|setInterval|setImmediate|queueMicrotask|requestAnimationFrame/,
    );
  });
});

// ---------------------------------------------------------------------------
// Cancellation: termination, not degradation
// ---------------------------------------------------------------------------

describe("chat route: caller cancellation", () => {
  it("abort during retrieval: 499, no chunks, generation never called, nothing persisted", async () => {
    const controller = new AbortController();
    mocks.runRetrieval.mockImplementation(
      async (_question: unknown, deps: { signal?: AbortSignal }) => {
        controller.abort();
        throw callerCancellationError(controller.signal);
      },
    );

    const response = await POST({ request: makeRequest(controller.signal) });
    expect(response.status).toBe(499);
    expect(await response.text()).toBe("");

    // Generation never ran after the abort.
    expect(mocks.generateText).not.toHaveBeenCalled();
    // Retrieval-phase cancellation: not even the user turn is persisted.
    expect(harness.inserts).toHaveLength(0);

    const cancelled = mocks.logEvent.mock.calls.find(
      (call) => call[1] === "chat.request_cancelled",
    );
    expect(cancelled).toBeDefined();
    expect(cancelled![3]).toMatchObject({ stage: "retrieval" });
  });

  it("abort during generation: 499, no chunks, no assistant message persisted", async () => {
    const controller = new AbortController();
    mocks.generateText.mockImplementation(async (args: { abortSignal?: AbortSignal }) => {
      // The caller goes away mid-generation; the provider call aborts.
      controller.abort();
      throw callerCancellationError(controller.signal);
    });

    const request = makeRequest(controller.signal);
    const response = await POST({ request });
    expect(response.status).toBe(499);
    expect(await response.text()).toBe("");

    // No assistant message is persisted; the user turn (persisted before
    // generation) is untouched.
    expect(harness.assistantInserts()).toHaveLength(0);
    expect(harness.userInserts()).toHaveLength(1);

    const cancelled = mocks.logEvent.mock.calls.find(
      (call) => call[1] === "chat.request_cancelled",
    );
    expect(cancelled).toBeDefined();
    expect(cancelled![3]).toMatchObject({ stage: "generation" });
  });
});

// ---------------------------------------------------------------------------
// Cancellation race guards: pre-flight checks between the async boundaries
// ---------------------------------------------------------------------------

describe("chat route: cancellation race guards", () => {
  function cancelledAtStage() {
    const cancelled = mocks.logEvent.mock.calls.find(
      (call) => call[1] === "chat.request_cancelled",
    );
    expect(cancelled).toBeDefined();
    return cancelled![3] as { stage: string };
  }

  it("abort between retrieval resolution and user persistence: 499, nothing persisted, generation never begins", async () => {
    const controller = new AbortController();
    mocks.runRetrieval.mockImplementation(async () => {
      // Retrieval resolved successfully; the caller goes away before ANY
      // post-retrieval side effect (user insert, thread update).
      controller.abort();
      return retrievalOutcome(evidence());
    });

    const response = await POST({ request: makeRequest(controller.signal) });
    expect(response.status).toBe(499);
    expect(await response.text()).toBe("");

    // Guard (a): not even the user turn was persisted; generation never began.
    expect(harness.inserts).toHaveLength(0);
    expect(harness.assistantInserts()).toHaveLength(0);
    expect(mocks.generateText).not.toHaveBeenCalled();
    expect(cancelledAtStage()).toMatchObject({ stage: "retrieval" });
  });

  it("abort while user/thread persistence is pending: 499, no assistant refusal insert, no generation afterward", async () => {
    const controller = new AbortController();
    // Hold the user insert in-flight and drop the client mid-await.
    const originalFrom = harness.db.from;
    harness.db.from = (table: string) => {
      const builder = originalFrom(table);
      if (table === "messages") {
        const originalInsert = builder.insert;
        builder.insert = (row: Record<string, unknown>) => {
          controller.abort();
          return new Promise<{ data: null; error: null }>((resolve) => {
            setTimeout(() => resolve(originalInsert(row)), 0);
          });
        };
      }
      return builder;
    };
    try {
      const response = await POST({ request: makeRequest(controller.signal) });
      expect(response.status).toBe(499);
      expect(await response.text()).toBe("");

      // The in-flight user insert may or may not have landed (no
      // transactional rollback is possible — see the route caveat). The
      // contract guarantees what comes AFTER guard (b): no assistant
      // message, and generation never runs afterward.
      expect(harness.assistantInserts()).toHaveLength(0);
      expect(mocks.generateText).not.toHaveBeenCalled();
      expect(cancelledAtStage()).toMatchObject({ stage: "retrieval" });
    } finally {
      harness.db.from = originalFrom;
    }
  });

  it("abort after the refusal branch, before generateText is invoked: 499, generation never called, no assistant insert", async () => {
    const controller = new AbortController();
    mocks.emitAsync.mockImplementation((event: unknown) => {
      // GENERATION_STARTED is emitted after guard (b) and before guard (c):
      // drop the client in that window.
      const record = event as { event?: string };
      if (record?.event === EVENTS.GENERATION_STARTED) controller.abort();
    });

    const response = await POST({ request: makeRequest(controller.signal) });
    expect(response.status).toBe(499);
    expect(await response.text()).toBe("");

    // Guard (c) fired before generateText was ever invoked.
    expect(mocks.generateText).not.toHaveBeenCalled();
    expect(harness.assistantInserts()).toHaveLength(0);
    // The grounded path was taken (no refusal branch); the user turn was
    // persisted before the abort.
    expect(harness.userInserts()).toHaveLength(1);
    expect(cancelledAtStage()).toMatchObject({ stage: "retrieval" });
  });

  it("abort after generateText resolves, before validation: candidate discarded, 499, no assistant insert", async () => {
    const controller = new AbortController();
    mocks.generateText.mockImplementation(async () => {
      // The caller goes away while the candidate is buffered back; the abort
      // lands before the route can validate. The candidate is syntactically
      // valid — the point is that it is DISCARDED anyway.
      controller.abort();
      return { text: "The notice period is 30 days [source_01]." };
    });

    const response = await POST({ request: makeRequest(controller.signal) });
    expect(response.status).toBe(499);
    expect(await response.text()).toBe("");

    // Guard (d): the unvalidated candidate is discarded — never validated,
    // never emitted, never persisted as an assistant message.
    expect(harness.assistantInserts()).toHaveLength(0);
    expect(harness.userInserts()).toHaveLength(1);
    expect(cancelledAtStage()).toMatchObject({ stage: "generation" });
  });

  it("ungrounded retrieval followed by cancellation: the grounded refusal is NEITHER inserted NOR emitted", async () => {
    const controller = new AbortController();
    mocks.runRetrieval.mockImplementation(async () => {
      controller.abort();
      return retrievalOutcome([], false);
    });

    const response = await POST({ request: makeRequest(controller.signal) });
    expect(response.status).toBe(499);
    expect(await response.text()).toBe("");

    // Guard (a) fired before the grounded-refusal branch: no refusal was
    // inserted into the database and nothing was emitted (empty 499 body).
    expect(harness.assistantInserts()).toHaveLength(0);
    expect(harness.inserts).toHaveLength(0);
    expect(mocks.generateText).not.toHaveBeenCalled();
    expect(cancelledAtStage()).toMatchObject({ stage: "retrieval" });
  });
});

// ---------------------------------------------------------------------------
// Post-validation disconnect semantics
// ---------------------------------------------------------------------------

describe("chat route: client disconnect during validated-answer emission", () => {
  it("OBSERVED: the validated answer is still persisted when the client disconnects mid-emission", async () => {
    const candidate = "The notice period is 30 days [source_01].";
    mocks.generateText.mockResolvedValue({ text: candidate });

    const controller = new AbortController();
    const request = makeRequest(controller.signal);
    const response = await POST({ request });
    expect(response.status).toBe(200);

    // Validation has succeeded and emission has started (first chunk read).
    // Now the client goes away mid-emission: the request signal aborts and
    // the connection drops (body cancelled), before persistence runs.
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    controller.abort();
    await reader.cancel();
    // Let the stream finalizers run.
    await new Promise((resolve) => setTimeout(resolve, 25));

    // OBSERVED BEHAVIOR: persistence still occurs. Nothing in the route gates
    // emission or onFinish on the request signal, and the AI SDK's stream
    // finalizer invokes onFinish on BOTH completion and cancellation — so the
    // fully-generated, validated answer is persisted with the FULL plan.text
    // even though the client only received a prefix.
    const assistant = harness.assistantInserts();
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.row["content"]).toBe(normalizeCitationMarkers(candidate));
  });
});

// ---------------------------------------------------------------------------
// Bounded buffered generation: output cap + deadline, caller wins the race
// ---------------------------------------------------------------------------

describe("chat route: bounded generation", () => {
  it("passes the configured maxOutputTokens to generateText", async () => {
    mocks.generateText.mockResolvedValue({ text: "Thirty days [source_01]." });

    await POST({ request: makeRequest() });

    expect(mocks.generateText).toHaveBeenCalledTimes(1);
    const args = mocks.generateText.mock.calls[0]![0] as { maxOutputTokens?: number };
    // The configured cap — not a hardcoded duplicate — is actually supplied.
    expect(args.maxOutputTokens).toBe(RETRIEVAL_CONFIG.generation.maxOutputTokens);
  });

  it("generation deadline expiry without caller abort takes the AI_UNAVAILABLE 503 path", async () => {
    const generation = RETRIEVAL_CONFIG.generation as { timeoutMs: number };
    const original = generation.timeoutMs;
    generation.timeoutMs = 25;
    try {
      // Provider hangs until its signal aborts — like a real stalled call.
      // The deadline (25ms) is the only thing that can abort it here.
      mocks.generateText.mockImplementation(
        (args: { abortSignal?: AbortSignal }) =>
          new Promise<{ text: string }>((_resolve, reject) => {
            const signal = args.abortSignal;
            const onAbort = () =>
              reject(new DOMException("The operation was aborted.", "AbortError"));
            if (signal?.aborted) onAbort();
            else signal?.addEventListener("abort", onAbort, { once: true });
          }),
      );

      const response = await POST({ request: makeRequest() });
      expect(response.status).toBe(503);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("AI_UNAVAILABLE");
      expect(harness.assistantInserts()).toHaveLength(0);

      const failed = mocks.emitAsync.mock.calls
        .map((call) => call[0] as Record<string, unknown>)
        .find((event) => event["event"] === EVENTS.GENERATION_FAILED);
      expect(failed).toBeDefined();
      expect(failed!["errorCode"]).toBe("AI_UNAVAILABLE");
      expect((failed!["attributes"] as Record<string, unknown>)["generation_timeout"]).toBe(true);
    } finally {
      generation.timeoutMs = original;
    }
  });

  it("caller abort at deadline expiry wins: 499 silent termination, not 503", async () => {
    const generation = RETRIEVAL_CONFIG.generation as { timeoutMs: number };
    const original = generation.timeoutMs;
    generation.timeoutMs = 60;
    try {
      mocks.generateText.mockImplementation(
        (args: { abortSignal?: AbortSignal }) =>
          new Promise<{ text: string }>((_resolve, reject) => {
            const signal = args.abortSignal;
            const onAbort = () =>
              reject(new DOMException("The operation was aborted.", "AbortError"));
            if (signal?.aborted) onAbort();
            else signal?.addEventListener("abort", onAbort, { once: true });
          }),
      );

      const controller = new AbortController();
      const request = makeRequest(controller.signal);
      const pending = POST({ request });
      // Let generation start, then drop the client well before the deadline.
      await vi.waitFor(() => expect(mocks.generateText).toHaveBeenCalledTimes(1));
      controller.abort();

      const response = await pending;
      // Caller cancellation wins over the generation timeout: silent
      // termination, not the 503 provider-error path — even though the thrown
      // error has the exact AbortError shape a deadline expiry produces. The
      // route checks the caller signal, not the error shape.
      expect(response.status).toBe(499);
      expect(await response.text()).toBe("");
      expect(harness.assistantInserts()).toHaveLength(0);

      const failed = mocks.emitAsync.mock.calls
        .map((call) => call[0] as Record<string, unknown>)
        .find((event) => event["event"] === EVENTS.GENERATION_FAILED);
      expect(failed).toBeUndefined();
      const cancelled = mocks.logEvent.mock.calls.find(
        (call) => call[1] === "chat.request_cancelled",
      );
      expect(cancelled).toBeDefined();
      expect(cancelled![3]).toMatchObject({ stage: "generation" });
    } finally {
      generation.timeoutMs = original;
    }
  });
});

// ---------------------------------------------------------------------------
// Reason-independence at the route boundary: every abort reason terminates
// ---------------------------------------------------------------------------

describe("chat route: caller cancellation reason-independence", () => {
  const variants: Array<{ label: string; present: boolean; value?: unknown }> = [
    { label: "abort() with no reason", present: false },
    {
      label: 'abort(new DOMException(..., "AbortError"))',
      present: true,
      value: new DOMException("client gone", "AbortError"),
    },
    { label: 'abort(new Error("cancelled"))', present: true, value: new Error("cancelled") },
    { label: 'abort("string reason")', present: true, value: "string reason" },
    { label: "abort(plain object)", present: true, value: { code: "CLIENT_GONE" } },
  ];

  it.each(variants)(
    "abort during retrieval ($label): 499, generation never begins, nothing persisted",
    async (variant) => {
      const controller = new AbortController();
      mocks.runRetrieval.mockImplementation(
        async (_question: unknown, _deps: { signal?: AbortSignal }) => {
          if (variant.present) controller.abort(variant.value);
          else controller.abort();
          throw callerCancellationError(controller.signal);
        },
      );

      const response = await POST({ request: makeRequest(controller.signal) });
      expect(response.status).toBe(499);
      expect(await response.text()).toBe("");

      // Generation never begins after a caller abort, whatever the reason.
      expect(mocks.generateText).not.toHaveBeenCalled();
      // No refusal is emitted (empty 499 body) and nothing is persisted —
      // not even the user turn at this stage.
      expect(harness.inserts).toHaveLength(0);

      const cancelled = mocks.logEvent.mock.calls.find(
        (call) => call[1] === "chat.request_cancelled",
      );
      expect(cancelled).toBeDefined();
      expect(cancelled![3]).toMatchObject({ stage: "retrieval" });
    },
  );
});
