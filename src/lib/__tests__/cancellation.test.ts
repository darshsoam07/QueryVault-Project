/**
 * Unit tests for the cancellation primitives in
 * src/lib/retrieval/cancellation.ts.
 *
 * What is proven here:
 *  - throwIfCallerCancelled throws the canonical, reason-independent
 *    caller-cancellation error on an aborted signal and returns silently on
 *    a live one;
 *  - linkAbort with an already-aborted caller short-circuits: the linked
 *    signal starts aborted, NO timeout timer is armed, and NO listener is
 *    attached to the caller (nothing outlives the dead request);
 *  - the normal linkAbort path is unchanged: timer armed, abort propagates,
 *    cleanup removes both.
 *
 * Safe-data discipline: no prompts, answers, evidence, or secrets appear.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  callerCancellationError,
  isCancellationError,
  linkAbort,
  throwIfCallerCancelled,
} from "@/lib/retrieval/cancellation";

describe("throwIfCallerCancelled", () => {
  it("throws the canonical cancellation error when the signal is aborted", () => {
    const controller = new AbortController();
    controller.abort(new Error("client gone"));
    expect(() => throwIfCallerCancelled(controller.signal)).toThrow(
      callerCancellationError(controller.signal),
    );
    try {
      throwIfCallerCancelled(controller.signal);
      expect.unreachable("must throw");
    } catch (error) {
      // Reason-independent canonical form: always a DOMException AbortError
      // with the original reason preserved as cause.
      expect(isCancellationError(error)).toBe(true);
      expect(error).toBeInstanceOf(DOMException);
      expect((error as Error).name).toBe("AbortError");
    }
  });

  it("returns silently when the signal is live", () => {
    const controller = new AbortController();
    expect(() => throwIfCallerCancelled(controller.signal)).not.toThrow();
  });
});

describe("linkAbort", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("already-aborted caller: linked signal starts aborted, no timer armed, no listener attached", () => {
    const caller = new AbortController();
    caller.abort(new Error("client already gone"));
    const addSpy = vi.spyOn(caller.signal, "addEventListener");
    const removeSpy = vi.spyOn(caller.signal, "removeEventListener");

    const linked = linkAbort(caller.signal, 60_000);

    // The provider call handed this signal is cancelled immediately.
    expect(linked.signal.aborted).toBe(true);
    // No timeout timer was armed and no listener was attached to the caller.
    expect(vi.getTimerCount()).toBe(0);
    expect(addSpy).not.toHaveBeenCalled();
    // cleanup() is a safe no-op on this path: nothing to clear, nothing to
    // remove, and it must not throw.
    linked.cleanup();
    expect(removeSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("already-aborted caller via abort() with no reason: same short-circuit", () => {
    const caller = new AbortController();
    caller.abort();
    const linked = linkAbort(caller.signal, 60_000);
    expect(linked.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    linked.cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("live caller: timer armed until cleanup; caller abort propagates to the linked signal", () => {
    const caller = new AbortController();
    const linked = linkAbort(caller.signal, 60_000);
    expect(linked.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    caller.abort();
    expect(linked.signal.aborted).toBe(true);

    linked.cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("live caller: timeout expiry aborts the linked signal; cleanup clears the timer", () => {
    const caller = new AbortController();
    const linked = linkAbort(caller.signal, 5_000);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(5_000);
    expect(linked.signal.aborted).toBe(true);

    linked.cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("no caller signal: only the timeout timer is armed and cleaned up", () => {
    const linked = linkAbort(undefined, 5_000);
    expect(linked.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    linked.cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });
});
