export interface ScrollSnapshot {
  scrollTop: number;
  scrollHeight: number;
  anchor?: HTMLElement;
  anchorY?: number;
}

/**
 * Captures the current scroll position and content height of a scroll container.
 * Returns null if container is not provided.
 */
export function captureScrollSnapshot(container: HTMLElement | null): ScrollSnapshot | null {
  if (!container) return null;
  const top = container.getBoundingClientRect?.().top ?? 0;
  const anchor =
    typeof container.querySelectorAll === "function"
      ? Array.from(container.querySelectorAll<HTMLElement>("[data-message-id]")).find(
          (element) => element.getBoundingClientRect().bottom > top,
        )
      : undefined;
  return {
    ...(anchor ? { anchor, anchorY: anchor.getBoundingClientRect().top } : {}),
    scrollTop: container.scrollTop,
    scrollHeight: container.scrollHeight,
  };
}

/**
 * Restores the relative scroll position by adjusting scrollTop for any change in scrollHeight.
 * Ensures the previously visible message stays at the exact same viewport Y coordinate.
 * Returns the applied heightDelta.
 */
export function restoreScrollSnapshot(
  container: HTMLElement | null,
  snapshot: ScrollSnapshot | null,
): number {
  if (!container || !snapshot) return 0;
  if (snapshot.anchor?.isConnected && snapshot.anchorY !== undefined) {
    const delta = snapshot.anchor.getBoundingClientRect().top - snapshot.anchorY;
    container.scrollTop += delta;
    return delta;
  }
  const newScrollHeight = container.scrollHeight;
  const heightDelta = newScrollHeight - snapshot.scrollHeight;
  container.scrollTop = snapshot.scrollTop + heightDelta;
  return heightDelta;
}
