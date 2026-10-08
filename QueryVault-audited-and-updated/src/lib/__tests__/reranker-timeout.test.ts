/**
 * Reranker timeout enforcement and caller-cancellation semantics.
 *
 * The declared `llmRerankerTimeoutMs` must bound the real provider call: a
 * stalled provider aborts the underlying request and the pipeline degrades to
 * the deterministic heuristic reranker instead of hanging or failing the chat
 * request. Timeout fallbacks are recorded separately from provider errors.
 *
 * Caller cancellation is a REQUEST TERMINATION event, not a degradation
 * event: when the caller's signal aborts, the provider call is aborted and a
 * canonical AbortError is thrown — the heuristic reranker is never consulted,
 * and the error propagates out of the retrieval pipeline so the route can
 * terminate the request (no answer, no refusal, no assistant message).
 *
 * Reason-independence: the invariant holds for EVERY AbortSignal.reason
 * (abort() with no reason, a DOMException AbortError, a plain Error, a
 * string, or a plain object). Where the provider call settles, the caller
 * signal (`callerSignal.aborted`) is the tiebreaker — not the error shape —
 * and every caller-abort outcome is normalized into a canonical DOMException
 * named "AbortError" (original reason preserved as `cause`), so
 * `isCancellationError` classifies every variant correctly.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AiProvider } from "@/lib/ai-gateway.server";
import { createLlmReranker, heuristicReranker, isCancellationError } from "@/lib/retrieval";
import { runRetrieval, type RetrievalDeps } from "@/lib/retrieval/pipeline";
import type { Candidate, FusedCandidate } from "@/lib/retrieval/types";

// ---------------------------------------------------------------- fixtures

const provider = {
  id: "openai",
  label: "test provider",
  baseUrl: "https://provider.test/v1",
  chatModel: "chat-model",
  utilityModel: "utility-model",
  embeddingModel: "embedding-model",
  embeddingDimensions: 3072,
  supportsDimensionsParam: true,
  authHeaders: () => ({}),
} as AiProvider;

function baseCandidates(): Candidate[] {
  return [
    {
      chunkId: "c1",
      documentId: "d1",
      filename: "a.pdf",
      page: 1,
      chunkIndex: 0,
      content: "The moon orbits the earth roughly once every month.",
      similarity: 0.9,
      lexicalRank: null,
      densePosition: 1,
      lexicalPosition: null,
    },
    {
      chunkId: "c2",
      documentId: "d1",
      filename: "a.pdf",
      page: 2,
      chunkIndex: 1,
      content: "Photosynthesis converts sunlight into chemical energy in plants.",
      similarity: 0.4,
      lexicalRank: null,
      densePosition: 2,
      lexicalPosition: null,
    },
  ];
}

function fusedCandidates(): FusedCandidate[] {
  return baseCandidates().map((candidate, index) => ({
    ...candidate,
    fusionScore: 1 - index * 0.4,
  }));
}

// ---------------------------------------------------------------- fetch stubs

/** Provider answers immediately with the given listwise scores. */
function okFetch(
  scores: Array<{ index: number; score: number }> = [
    { index: 0, score: 0.9 },
    { index: 1, score: 0.2 },
  ],
) {
  return vi.fn(async (_url: unknown, _init?: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ scores }) } }],
    }),
  }));
}

/** Provider fails fast with an HTTP error. */
function errorFetch(status = 503) {
  return vi.fn(async () => ({ ok: false, status }));
}

type HangState = {
  calls: number;
  /** The signal the stubbed fetch actually received. */
  signal: AbortSignal | null | undefined;
  aborted: boolean;
  settled: boolean;
};

/**
 * Provider that hangs until its signal aborts — like a real fetch, which
 * rejects with an AbortError when the signal fires. Never resolves on its own.
 */
function hangingFetch(state: HangState) {
  return vi.fn(
    (_url: unknown, init?: RequestInit) =>
      new Promise<never>((_resolve, reject) => {
        state.calls += 1;
        state.signal = init?.signal;
        const onAbort = () => {
          state.aborted = true;
          state.settled = true;
          reject(new DOMException("The operation was aborted.", "AbortError"));
        };
        if (init?.signal?.aborted) {
          onAbort();
          return;
        }
        init?.signal?.addEventListener("abort", onAbort, { once: true });
      }),
  );
}

function retrievalDeps(reranker: RetrievalDeps["reranker"]): RetrievalDeps {
  return {
    expand: async (question) => ({ queries: [question], rewritten: false }),
    dense: async () => ({
      candidates: baseCandidates(),
      embeddingLatencyMs: 1,
      queryLatencyMs: 1,
    }),
    lexical: async () => ({ candidates: [], queryLatencyMs: 1 }),
    reranker,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------- tests

describe("llm reranker timeout enforcement", () => {
  it("returns LLM scores with no fallback when the provider answers in time", async () => {
    vi.stubGlobal("fetch", okFetch());
    const reranker = createLlmReranker(provider, undefined, { timeoutMs: 1000 });

    const result = await reranker.rerank("moon orbit", fusedCandidates(), 2);

    expect(result.fallback).toBeUndefined();
    expect(result.ranked).toHaveLength(2);
    expect(result.ranked[0]!.chunkId).toBe("c1");
    expect(result.ranked[0]!.rerankScore).toBeCloseTo(0.9, 4);
    expect(result.ranked.every((c) => c.rerankerName === "llm:utility-model")).toBe(true);
  });

  it("falls back to the heuristic reranker and aborts the hung request on timeout", async () => {
    const state: HangState = { calls: 0, signal: null, aborted: false, settled: false };
    vi.stubGlobal("fetch", hangingFetch(state));
    const reranker = createLlmReranker(provider, undefined, { timeoutMs: 25 });

    const result = await reranker.rerank("moon orbit", fusedCandidates(), 2);

    expect(result.fallback?.kind).toBe("timeout");
    expect(result.fallback?.rerankerName).toBe("heuristic-overlap");
    // A REAL signal reached the provider call, and the underlying request was
    // aborted when the timeout fired — nothing left running in the background.
    expect(state.calls).toBe(1);
    expect(state.signal).toBeInstanceOf(AbortSignal);
    expect(state.aborted).toBe(true);
    expect(state.settled).toBe(true);
    // Scores are exactly what the heuristic reranker produces on its own.
    const expected = await heuristicReranker.rerank("moon orbit", fusedCandidates(), 2);
    expect(result.ranked).toEqual(expected.ranked);
    expect(result.ranked.every((c) => c.rerankerName === "heuristic-overlap")).toBe(true);
  });

  it("records a provider-error fallback, distinct from a timeout", async () => {
    vi.stubGlobal("fetch", errorFetch(503));
    const reranker = createLlmReranker(provider, undefined, { timeoutMs: 1000 });

    const result = await reranker.rerank("moon orbit", fusedCandidates(), 2);

    expect(result.fallback?.kind).toBe("provider-error");
    expect(result.fallback?.rerankerName).toBe("heuristic-overlap");
    expect(result.ranked.every((c) => c.rerankerName === "heuristic-overlap")).toBe(true);
  });

  it("rejects with an AbortError on an already-cancelled caller signal without firing the provider call", async () => {
    const heuristicSpy = vi.spyOn(heuristicReranker, "rerank");
    const state: HangState = { calls: 0, signal: null, aborted: false, settled: false };
    vi.stubGlobal("fetch", hangingFetch(state));
    const controller = new AbortController();
    controller.abort();
    const reranker = createLlmReranker(provider, undefined, { timeoutMs: 1000 });

    const pending = reranker.rerank("moon orbit", fusedCandidates(), 2, {
      signal: controller.signal,
    });

    let caught: unknown;
    try {
      await pending;
    } catch (error) {
      caught = error;
    }
    // Cancellation is distinguishable from provider errors by name.
    expect(isCancellationError(caught)).toBe(true);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe("AbortError");
    // No provider call was fired, and the heuristic reranker was never
    // consulted — cancellation terminates, it does not degrade.
    expect(state.calls).toBe(0);
    expect(heuristicSpy).not.toHaveBeenCalled();
  });

  it("aborts the underlying request and throws when the caller cancels mid-flight", async () => {
    const heuristicSpy = vi.spyOn(heuristicReranker, "rerank");
    const state: HangState = { calls: 0, signal: null, aborted: false, settled: false };
    vi.stubGlobal("fetch", hangingFetch(state));
    const controller = new AbortController();
    const reranker = createLlmReranker(provider, undefined, { timeoutMs: 5000 });

    const pending = reranker.rerank("moon orbit", fusedCandidates(), 2, {
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();

    let caught: unknown;
    try {
      await pending;
    } catch (error) {
      caught = error;
    }
    expect(isCancellationError(caught)).toBe(true);
    expect((caught as Error).name).toBe("AbortError");
    // The provider saw a REAL aborted signal and its request settled — no
    // request left running in the background after the throw.
    expect(state.calls).toBe(1);
    expect(state.signal).toBeInstanceOf(AbortSignal);
    expect(state.signal!.aborted).toBe(true);
    expect(state.aborted).toBe(true);
    expect(state.settled).toBe(true);
    // The heuristic reranker was never consulted after the abort.
    expect(heuristicSpy).not.toHaveBeenCalled();
  });

  it("cleans up the timeout timer and the caller listener after a timeout fallback", async () => {
    vi.useFakeTimers();
    try {
      const state: HangState = { calls: 0, signal: null, aborted: false, settled: false };
      vi.stubGlobal("fetch", hangingFetch(state));
      const controller = new AbortController();
      const addSpy = vi.spyOn(controller.signal, "addEventListener");
      const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
      const reranker = createLlmReranker(provider, undefined, { timeoutMs: 25 });

      const pending = reranker.rerank("moon orbit", fusedCandidates(), 2, {
        signal: controller.signal,
      });
      await vi.advanceTimersByTimeAsync(30);
      const result = await pending;

      expect(result.fallback?.kind).toBe("timeout");
      // No active timer left behind…
      expect(vi.getTimerCount()).toBe(0);
      // …and the caller-signal listener was attached once and removed once.
      expect(addSpy).toHaveBeenCalledTimes(1);
      expect(removeSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans up the timer and the caller listener when the caller aborts mid-flight", async () => {
    const state: HangState = { calls: 0, signal: null, aborted: false, settled: false };
    vi.stubGlobal("fetch", hangingFetch(state));
    const controller = new AbortController();
    const addSpy = vi.spyOn(controller.signal, "addEventListener");
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    const reranker = createLlmReranker(provider, undefined, { timeoutMs: 5000 });

    const pending = reranker.rerank("moon orbit", fusedCandidates(), 2, {
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    // The finally in the reranker ran cleanup even though it threw.
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  it("does not fail the whole request when the LLM reranker times out", async () => {
    const state: HangState = { calls: 0, signal: null, aborted: false, settled: false };
    vi.stubGlobal("fetch", hangingFetch(state));
    const deps = retrievalDeps(createLlmReranker(provider, undefined, { timeoutMs: 25 }));

    const outcome = await runRetrieval("moon orbit", deps);

    // Retrieval completed with heuristic scores instead of throwing.
    expect(outcome.ranked.length).toBeGreaterThan(0);
    expect(outcome.telemetry.rerankerFallback).toBe("timeout");
  });

  it("propagates caller cancellation out of the retrieval pipeline — no outcome, no fallback", async () => {
    const state: HangState = { calls: 0, signal: null, aborted: false, settled: false };
    vi.stubGlobal("fetch", hangingFetch(state));
    const controller = new AbortController();
    const deps = retrievalDeps(createLlmReranker(provider, undefined, { timeoutMs: 5000 }));
    deps.signal = controller.signal;

    const pending = runRetrieval("moon orbit", deps);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();

    // The pipeline does not swallow or convert the cancellation: it rejects
    // with the AbortError, so generation is never reached downstream.
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(state.aborted).toBe(true);
    expect(state.settled).toBe(true);
  });

  it("isCancellationError tells caller cancellation apart from provider errors", () => {
    expect(isCancellationError(new DOMException("The operation was aborted.", "AbortError"))).toBe(
      true,
    );
    expect(isCancellationError(new DOMException("Something else.", "NetworkError"))).toBe(false);
    expect(isCancellationError(new Error("rerank_unparsable"))).toBe(false);
    expect(isCancellationError(new Error("boom"))).toBe(false);
    expect(isCancellationError(null)).toBe(false);
    expect(isCancellationError(undefined)).toBe(false);
    expect(isCancellationError("AbortError")).toBe(false);
  });

  it("produces no unhandled rejections after caller cancellation", async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const state: HangState = { calls: 0, signal: null, aborted: false, settled: false };
      vi.stubGlobal("fetch", hangingFetch(state));
      const controller = new AbortController();
      const reranker = createLlmReranker(provider, undefined, { timeoutMs: 5000 });

      const pending = reranker.rerank("moon orbit", fusedCandidates(), 2, {
        signal: controller.signal,
      });
      controller.abort();
      // The rejection is observed here — nothing is left unhandled.
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      // Flush microtasks and timers so any stray rejection would surface.
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(rejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("reranker telemetry", () => {
  it("records the timeout fallback and names the heuristic reranker in the trace fields", async () => {
    const state: HangState = { calls: 0, signal: null, aborted: false, settled: false };
    vi.stubGlobal("fetch", hangingFetch(state));
    const deps = retrievalDeps(createLlmReranker(provider, undefined, { timeoutMs: 25 }));

    const outcome = await runRetrieval("moon orbit", deps);

    expect(outcome.telemetry.rerankerFallback).toBe("timeout");
    expect(outcome.telemetry.rerankerName).toBe("heuristic-overlap");
    expect(outcome.ranked.every((c) => c.rerankerName === "heuristic-overlap")).toBe(true);
  });

  it("names the LLM reranker with no fallback when it succeeds", async () => {
    vi.stubGlobal("fetch", okFetch());
    const deps = retrievalDeps(createLlmReranker(provider, undefined, { timeoutMs: 1000 }));

    const outcome = await runRetrieval("moon orbit", deps);

    expect(outcome.telemetry.rerankerFallback).toBeNull();
    expect(outcome.telemetry.rerankerName).toBe("llm:utility-model");
    expect(outcome.ranked.every((c) => c.rerankerName === "llm:utility-model")).toBe(true);
  });

  it("records a provider-error fallback separately from a timeout in telemetry", async () => {
    vi.stubGlobal("fetch", errorFetch(500));
    const deps = retrievalDeps(createLlmReranker(provider, undefined, { timeoutMs: 1000 }));

    const outcome = await runRetrieval("moon orbit", deps);

    expect(outcome.telemetry.rerankerFallback).toBe("provider-error");
    expect(outcome.telemetry.rerankerName).toBe("heuristic-overlap");
  });
});

// ---------------------------------------------------------------------------
// Reason-independent caller cancellation: every AbortSignal.reason variant
// must terminate the request — never a timeout/provider classification, never
// heuristic reranking.
// ---------------------------------------------------------------------------

type ReasonVariant = { label: string; present: boolean; value?: unknown };

const reasonVariants: ReasonVariant[] = [
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

function abortWith(controller: AbortController, variant: ReasonVariant): void {
  if (variant.present) controller.abort(variant.value);
  else controller.abort();
}

/**
 * Every variant must surface as the canonical cancellation: a DOMException
 * named "AbortError", with the original abort reason preserved as `cause`
 * (or the reason itself when it was already a canonical AbortError).
 */
function expectCanonicalCancellation(caught: unknown, variant: ReasonVariant): void {
  expect(isCancellationError(caught)).toBe(true);
  expect(caught).toBeInstanceOf(Error);
  expect(caught).toBeInstanceOf(DOMException);
  expect((caught as Error).name).toBe("AbortError");
  if (
    variant.present &&
    variant.value instanceof DOMException &&
    variant.value.name === "AbortError"
  ) {
    // Already canonical: the original reason travels untouched.
    expect(caught).toBe(variant.value);
  } else if (variant.present) {
    // Wrapped: the original reason is preserved as cause, not lost.
    expect((caught as { cause?: unknown }).cause).toBe(variant.value);
  } else {
    expect((caught as { cause?: unknown }).cause).toBeUndefined();
  }
}

describe("reason-independent caller cancellation", () => {
  it.each(reasonVariants)(
    "pre-flight ($label): canonical AbortError, no provider call, heuristic never consulted, no listener/timer",
    async (variant) => {
      const heuristicSpy = vi.spyOn(heuristicReranker, "rerank");
      const state: HangState = { calls: 0, signal: null, aborted: false, settled: false };
      vi.stubGlobal("fetch", hangingFetch(state));
      const controller = new AbortController();
      const addSpy = vi.spyOn(controller.signal, "addEventListener");
      const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
      abortWith(controller, variant);

      const reranker = createLlmReranker(provider, undefined, { timeoutMs: 5000 });
      const caught = await reranker
        .rerank("moon orbit", fusedCandidates(), 2, { signal: controller.signal })
        .then(
          () => {
            throw new Error("rerank should have thrown for a cancelled caller");
          },
          (error: unknown) => error,
        );

      expectCanonicalCancellation(caught, variant);
      // No provider call was fired, and the heuristic reranker was never
      // consulted — cancellation terminates, it does not degrade.
      expect(state.calls).toBe(0);
      expect(heuristicSpy).not.toHaveBeenCalled();
      // The pre-flight throw happens before linkAbort: no listener attached,
      // no timer armed, nothing to leak.
      expect(addSpy).not.toHaveBeenCalled();
      expect(removeSpy).not.toHaveBeenCalled();
    },
  );

  it.each(reasonVariants)(
    "mid-flight ($label): provider signal aborted, canonical AbortError, heuristic never consulted, listener cleaned up",
    async (variant) => {
      const heuristicSpy = vi.spyOn(heuristicReranker, "rerank");
      const state: HangState = { calls: 0, signal: null, aborted: false, settled: false };
      vi.stubGlobal("fetch", hangingFetch(state));
      const controller = new AbortController();
      const addSpy = vi.spyOn(controller.signal, "addEventListener");
      const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
      const reranker = createLlmReranker(provider, undefined, { timeoutMs: 5000 });

      const pending = reranker.rerank("moon orbit", fusedCandidates(), 2, {
        signal: controller.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      abortWith(controller, variant);
      const caught = await pending.then(
        () => {
          throw new Error("rerank should have thrown for a cancelled caller");
        },
        (error: unknown) => error,
      );

      expectCanonicalCancellation(caught, variant);
      // The provider saw a REAL aborted signal and its request settled — no
      // request left running in the background after the throw.
      expect(state.calls).toBe(1);
      expect(state.signal).toBeInstanceOf(AbortSignal);
      expect(state.signal!.aborted).toBe(true);
      expect(state.aborted).toBe(true);
      expect(state.settled).toBe(true);
      // The heuristic reranker was never consulted after the abort.
      expect(heuristicSpy).not.toHaveBeenCalled();
      // The caller-signal listener was attached once and removed once; the
      // timeout timer was cleared in the finally.
      expect(addSpy).toHaveBeenCalledTimes(1);
      expect(removeSpy).toHaveBeenCalledTimes(1);
    },
  );

  it("mid-flight abort with a non-AbortError reason leaves no timer behind", async () => {
    vi.useFakeTimers();
    try {
      const state: HangState = { calls: 0, signal: null, aborted: false, settled: false };
      vi.stubGlobal("fetch", hangingFetch(state));
      const controller = new AbortController();
      const reranker = createLlmReranker(provider, undefined, { timeoutMs: 5000 });

      const pending = reranker.rerank("moon orbit", fusedCandidates(), 2, {
        signal: controller.signal,
      });
      await vi.advanceTimersByTimeAsync(10);
      // The critical variant: a plain Error reason, not named "AbortError".
      controller.abort(new Error("cancelled"));
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(reasonVariants)(
    "runRetrieval rejects as cancellation for $label — no outcome, no fallback",
    async (variant) => {
      const controller = new AbortController();
      abortWith(controller, variant);
      const deps = retrievalDeps(createLlmReranker(provider, undefined, { timeoutMs: 5000 }));
      deps.signal = controller.signal;

      // The pipeline does not swallow or convert the cancellation: it rejects
      // with the canonical AbortError, so generation is never reached.
      await expect(runRetrieval("moon orbit", deps)).rejects.toMatchObject({
        name: "AbortError",
      });
    },
  );
});
