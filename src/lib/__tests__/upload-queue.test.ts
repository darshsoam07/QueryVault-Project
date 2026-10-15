import { describe, expect, it } from "vitest";
import { UploadQueue } from "../upload-queue";

describe("bounded concurrent upload scheduler", () => {
  it("runs ten independent uploads with measured overlap and a ceiling of three", async () => {
    const queue = new UploadQueue(3);
    let active = 0,
      peak = 0;
    const completed: number[] = [];
    const tasks = Array.from({ length: 10 }, (_, id) =>
      queue.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        completed.push(id);
        return id;
      }),
    );
    expect(await Promise.all(tasks)).toHaveLength(10);
    expect(completed).toHaveLength(10);
    expect(peak).toBe(3);
    expect(active).toBe(0);
  });
  it("a failed file does not cancel siblings and more work can arrive while busy", async () => {
    const queue = new UploadQueue(2);
    const outcomes = await Promise.allSettled([
      queue.run(async () => {
        throw new Error("corrupt");
      }),
      queue.run(async () => "ready"),
      queue.run(async () => "added later"),
    ]);
    expect(outcomes.map((item) => item.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
  });
  it("cancels queued work without ever executing its upload", async () => {
    const queue = new UploadQueue(1);
    let release!: () => void;
    const first = queue.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const controller = new AbortController();
    let executed = false;
    const cancelled = queue.run(async () => {
      executed = true;
    }, controller.signal);
    controller.abort();
    const checked = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    release();
    await first;
    await checked;
    expect(executed).toBe(false);
    await expect(queue.run(async () => "retry")).resolves.toBe("retry");
  });
});
