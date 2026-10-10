import { describe, expect, it } from "vitest";
import { captureScrollSnapshot, restoreScrollSnapshot } from "../scroll-anchoring";

describe("scroll-anchoring utility", () => {
  function makeMockContainer(initialScrollTop: number, initialScrollHeight: number) {
    let scrollTop = initialScrollTop;
    let scrollHeight = initialScrollHeight;
    return {
      get scrollTop() {
        return scrollTop;
      },
      set scrollTop(val: number) {
        scrollTop = val;
      },
      get scrollHeight() {
        return scrollHeight;
      },
      set scrollHeight(val: number) {
        scrollHeight = val;
      },
    } as unknown as HTMLElement;
  }

  it("captures snapshot and restores position when content height increases by 300px", () => {
    const container = makeMockContainer(150, 1000);
    const snapshot = captureScrollSnapshot(container);
    expect(snapshot).toEqual({ scrollTop: 150, scrollHeight: 1000 });

    // Older messages prepended -> scrollHeight increases by 300px
    (container as unknown as { scrollHeight: number }).scrollHeight = 1300;

    const delta = restoreScrollSnapshot(container, snapshot);
    expect(delta).toBe(300);
    // scrollTop should increase by exactly 300px to maintain visible element at same Y
    expect(container.scrollTop).toBe(450);
  });

  it("handles zero-height change without shifting scrollTop", () => {
    const container = makeMockContainer(200, 1000);
    const snapshot = captureScrollSnapshot(container);

    const delta = restoreScrollSnapshot(container, snapshot);
    expect(delta).toBe(0);
    expect(container.scrollTop).toBe(200);
  });

  it("handles multiple sequential pagination operations accurately", () => {
    const container = makeMockContainer(100, 1000);

    // Page 1 prepended (+250px)
    const snap1 = captureScrollSnapshot(container);
    (container as unknown as { scrollHeight: number }).scrollHeight = 1250;
    restoreScrollSnapshot(container, snap1);
    expect(container.scrollTop).toBe(350);

    // User scrolls up a bit to read older messages
    container.scrollTop = 120;

    // Page 2 prepended (+400px)
    const snap2 = captureScrollSnapshot(container);
    (container as unknown as { scrollHeight: number }).scrollHeight = 1650;
    restoreScrollSnapshot(container, snap2);
    expect(container.scrollTop).toBe(520);
  });

  it("safely handles null container or null snapshot", () => {
    expect(captureScrollSnapshot(null)).toBeNull();
    const container = makeMockContainer(100, 500);
    expect(restoreScrollSnapshot(null, { scrollTop: 10, scrollHeight: 20 })).toBe(0);
    expect(restoreScrollSnapshot(container, null)).toBe(0);
    expect(container.scrollTop).toBe(100);
  });
});
