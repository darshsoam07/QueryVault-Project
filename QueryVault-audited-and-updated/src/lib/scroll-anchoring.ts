export interface ScrollSnapshot {
  scrollTop: number;
  scrollHeight: number;
}

/**
 * Captures the current scroll position and content height of a scroll container.
 * Returns null if container is not provided.
 */
export function captureScrollSnapshot(container: HTMLElement | null): ScrollSnapshot | null {
  if (!container) return null;
  return {
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
  const newScrollHeight = container.scrollHeight;
  const heightDelta = newScrollHeight - snapshot.scrollHeight;
  container.scrollTop = snapshot.scrollTop + heightDelta;
  return heightDelta;
}
