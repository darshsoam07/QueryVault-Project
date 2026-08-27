import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

/** Exported so render-time gates can subscribe to changes without restating it. */
export const REDUCED_MOTION_QUERY = QUERY;

/**
 * SSR-safe read of the user's motion preference.
 *
 * Every JS animation entry point checks this before building anything. The
 * `@media (prefers-reduced-motion: reduce)` block in styles.css is the backstop
 * for stylesheet-driven animation; this is the gate for JS-driven animation,
 * where "the timeline is never created" is a stronger guarantee than "the
 * timeline runs with duration 0" — no ScrollTrigger is registered, no RAF loop
 * starts, and scrolling stays entirely native.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(QUERY).matches;
}

/**
 * Reactive variant, shaped like `useIsMobile` in src/hooks/use-mobile.tsx.
 *
 * Deliberately starts `false` so the server render and the first client render
 * agree — reading matchMedia during render would hydrate-mismatch for anyone
 * who has the preference set. Effects that build timelines therefore call
 * `prefersReducedMotion()` directly rather than waiting a render for this to
 * settle; this hook is for the render-time branches (whether to mount a canvas
 * at all).
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(QUERY);
    const onChange = () => setReduced(mql.matches);
    mql.addEventListener("change", onChange);
    setReduced(mql.matches);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return reduced;
}
