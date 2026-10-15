/** Slots remain occupied until work actually settles, including cancellation. */
export class UploadQueue {
  private active = 0;
  private pending: Array<() => void> = [];
  constructor(readonly concurrency = 3) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Invalid concurrency");
  }
  run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      let started = false;
      const cancel = () => {
        if (started) return;
        const index = this.pending.indexOf(start);
        if (index >= 0) this.pending.splice(index, 1);
        signal?.removeEventListener("abort", cancel);
        reject(signal?.reason ?? new DOMException("Cancelled", "AbortError"));
      };
      const release = () => {
        this.active--;
        this.pump();
      };
      const start = () => {
        if (signal?.aborted) {
          cancel();
          return;
        }
        started = true;
        signal?.removeEventListener("abort", cancel);
        this.active++;
        try {
          Promise.resolve(work()).then(resolve, reject).finally(release);
        } catch (error) {
          reject(error);
          release();
        }
      };
      if (signal?.aborted) {
        cancel();
        return;
      }
      signal?.addEventListener("abort", cancel, { once: true });
      this.pending.push(start);
      this.pump();
    });
  }
  private pump() {
    while (this.active < this.concurrency && this.pending.length) this.pending.shift()!();
  }
}
