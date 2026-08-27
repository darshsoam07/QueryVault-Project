/**
 * Motion tokens.
 *
 * Durations and easings live here rather than inline at each call site, so the
 * whole app moves at one tempo and retuning it is a single edit.
 *
 * The scale is deliberately coarse — micro feedback, card entrance, hero
 * statement, section transition, scroll-driven sequence. An animation that fits
 * none of those five is usually an animation that should not exist.
 */
export const DUR = {
  /** Hover/press/toggle feedback. Under ~0.15s reads as a glitch, over ~0.25s as lag. */
  micro: 0.2,
  /** Cards and list items entering. */
  card: 0.4,
  /** Hero statement — the one place a long duration is earned. */
  hero: 0.9,
  /** Section and route transitions. */
  page: 0.6,
  /** Scroll-driven storytelling, scrubbed rather than played. */
  story: 1.6,
} as const;

/**
 * Easings.
 *
 * No `linear` — nothing in a UI moves at constant velocity. No `back.out`
 * either: the overshoot reads as playful, and this product's proposition is
 * "we do not make things up", which is not a playful claim.
 */
export const EASE = {
  /** Small movements and exits. */
  soft: "power2.out",
  /** Default for entrances — decelerates harder, so arrival feels deliberate. */
  out: "power3.out",
  /** Hero reveals, where the arrival should feel final. */
  expo: "expo.out",
} as const;

/** Per-item offsets for staggered groups. Beyond ~8 items, use `each` not `amount`. */
export const STAGGER = {
  tight: 0.04,
  normal: 0.07,
  loose: 0.12,
} as const;

/**
 * Where a scroll-triggered element should start animating: once its top has
 * risen to 85% of the viewport height. Early enough that it is already settled
 * by the time it reaches reading position, late enough to still read as a
 * response to scrolling.
 */
export const REVEAL_START = "top 85%";
