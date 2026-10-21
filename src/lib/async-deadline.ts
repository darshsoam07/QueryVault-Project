/** A cancellable deadline including thenable SDK requests. No network/logging. */
export function withDeadline<T>(
  operation: (signal: AbortSignal) => PromiseLike<T> | T,
  milliseconds: number,
  parent?: AbortSignal,
): Promise<T> {
  parent?.throwIfAborted();
  const controller = new AbortController();
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  const started = performance.now();
  const timeout = () =>
    controller.abort(new DOMException("Operation deadline exceeded", "TimeoutError"));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(timeout, milliseconds);
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return operation(signal);
      })
      .then(
        (value) => {
          if (performance.now() - started >= milliseconds) timeout();
          cleanup();
          if (signal.aborted) reject(signal.reason);
          else resolve(value);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
  });
}

/** PostgREST supports abortSignal; plain promises remain deadline-bounded. */
export function withRequestSignal<T>(request: T, signal: AbortSignal): T {
  const candidate = request as T & { abortSignal?: (signal: AbortSignal) => T };
  return typeof candidate.abortSignal === "function" ? candidate.abortSignal(signal) : request;
}

export function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
