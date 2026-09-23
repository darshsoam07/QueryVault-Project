/**
 * Caller-cancellation semantics for the retrieval pipeline and the chat route.
 *
 * Cancellation is a REQUEST TERMINATION event, never a degradation event. When
 * the caller's AbortSignal fires, in-flight work aborts and the cancellation
 * error propagates up untouched: no heuristic fallback, no refusal, no
 * assistant message, no background continuation.
 *
 * Reason-independence: the invariant holds for EVERY AbortSignal.reason, not
 * just the default. `controller.abort()` with no reason, with a DOMException
 * AbortError, with a plain Error, with a string, or with a plain object must
 * ALL terminate the request — none may be classified as a timeout, a provider
 * error, or trigger heuristic reranking. Two mechanisms enforce this:
 *
 * 1. Where a provider call settles, classification checks the associated
 *    CALLER SIGNAL (`callerSignal.aborted`), not just the error shape. The
 *    reranker and the chat route's generation catch use the signal as the
 *    tiebreaker when a caller abort races a timeout, because a timeout-abort
 *    and a caller-abort surface with the same error shape.
 * 2. Every caller-abort outcome is normalized into one canonical error: a
 *    DOMException named "AbortError", with the original `signal.reason`
 *    preserved as `cause`. Downstream `isCancellationError` checks therefore
 *    work for every reason variant without every call site re-deriving the
 *    classification from the signal.
 *
 * SECURITY: these helpers never touch prompt, answer, evidence, or secret
 * content — they only inspect the signal state and the error's name/cause.
 */

/**
 * True when the error is a caller-cancellation, as opposed to a provider or
 * application failure. Reliable because every caller-abort path throws the
 * canonical form built by `callerCancellationError` below. Provider failures
 * surface as `GatewayError` (or plain Errors like `rerank_unparsable`) and are
 * never named "AbortError".
 */
export function isCancellationError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Builds the cancellation error thrown when the caller's signal aborted.
 *
 * ALWAYS returns a DOMException named "AbortError", whatever the caller used
 * as the abort reason: `abort()` with no reason, `abort(new DOMException(...,
 * "AbortError"))`, `abort(new Error("cancelled"))`, `abort("string")`, or
 * `abort({...})`. A reason that is already a canonical AbortError DOMException
 * is returned as-is; anything else is wrapped, with the original reason
 * preserved as `cause` (assigned manually — DOMException's constructor takes
 * only `(message, name)`).
 *
 * Normalizing here is what makes `isCancellationError` reason-independent:
 * without it, `abort(new Error("cancelled"))` would surface an error named
 * "Error" and slip past the cancellation checks into the degradation paths.
 */
export function callerCancellationError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof DOMException && reason.name === "AbortError") return reason;
  const error = new DOMException("Request cancelled by caller.", "AbortError");
  if (reason !== undefined) {
    (error as Error & { cause?: unknown }).cause = reason;
  }
  return error;
}

/**
 * Throws the canonical caller-cancellation error when the signal has already
 * aborted; returns silently otherwise. Use as a pre-flight guard at points in
 * the request lifecycle where no asynchronous boundary throws for us — e.g.
 * after retrieval resolves and before any post-retrieval side effect, before
 * starting generation, and after generation resolves but before validation.
 * Checking the signal (not the error shape) makes the guard
 * reason-independent: every abort reason terminates the request.
 */
export function throwIfCallerCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw callerCancellationError(signal);
}

/**
 * Combines a caller-owned signal with a timeout into one signal that aborts
 * when EITHER fires. The returned signal is passed to the real provider
 * request, so aborting it aborts the underlying HTTP call — no uncancelled
 * `Promise.race`, no request left running in the background.
 *
 * If the caller signal is already aborted, the linked signal starts aborted
 * WITHOUT arming the timeout timer and WITHOUT attaching a listener to the
 * caller: no provider call is ever fired dead-on-arrival, and nothing
 * outlives the already-dead request. `cleanup()` on this path is a safe
 * no-op.
 *
 * Callers MUST call `cleanup()` (e.g. in a `finally`) so the timer and the
 * listener do not outlive the request.
 */
export function linkAbort(
  caller: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  // Already gone: short-circuit before arming anything. The linked signal
  // starts aborted, so a provider call handed this signal is cancelled
  // immediately; no timer, no listener, nothing to leak.
  if (caller?.aborted) {
    controller.abort();
    return { signal: controller.signal, cleanup: () => {} };
  }
  const onCallerAbort = () => controller.abort();
  let listening = false;
  if (caller) {
    caller.addEventListener("abort", onCallerAbort, { once: true });
    listening = true;
  }
  const timer = setTimeout(() => controller.abort(), Math.max(0, timeoutMs));
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (listening && caller) caller.removeEventListener("abort", onCallerAbort);
    },
  };
}
