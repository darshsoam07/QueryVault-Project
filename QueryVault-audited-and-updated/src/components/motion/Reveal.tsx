import { useLayoutEffect, useRef, type FC, type JSX, type ReactNode, type Ref } from "react";

import { gsap } from "@/lib/motion/gsap";
import { prefersReducedMotion } from "@/lib/motion/reduced-motion";
import { DUR, EASE, REVEAL_START, STAGGER } from "@/lib/motion/tokens";

type RevealProps = {
  children: ReactNode;
  /** Element to render. Use a semantic tag rather than nesting an extra div. */
  as?: keyof JSX.IntrinsicElements;
  className?: string;
  /**
   * Animate direct children individually instead of the container as one block.
   * Use for card grids and lists — the eye reads a stagger as "these are peers".
   */
  stagger?: keyof typeof STAGGER | false;
  /** Seconds. Only for sequencing against a sibling reveal — keep under ~0.3. */
  delay?: number;
  /** Travel distance in px. Small by default: a hint of motion, not a slide. */
  y?: number;
  /** Play immediately instead of on scroll — for content already in view on load. */
  immediate?: boolean;
};

/**
 * Polymorphic tag, typed by hand.
 *
 * `keyof JSX.IntrinsicElements` collapses to the union of *every* element's
 * props, whose `ref` types are mutually incompatible, so `<Tag ref={...}>` will
 * not type-check against it. Narrowing to the three props actually passed is
 * both accurate and less machinery than a fully generic polymorphic component.
 */
type RevealTag = FC<{
  ref?: Ref<HTMLElement> | undefined;
  className?: string | undefined;
  children?: ReactNode | undefined;
}>;

/**
 * The one scroll-reveal primitive. Every section on the public pages uses it
 * rather than hand-rolling a ScrollTrigger, so reveals share a tempo and there
 * is a single place to change how the whole site enters.
 *
 * Two decisions worth stating:
 *
 * 1. **`gsap.from`, not a CSS `opacity: 0` starting state.** The content is
 *    visible in the HTML and GSAP moves it *out* and back in. If JS fails, is
 *    blocked, or the ScrollTrigger never fires, the page still reads. A
 *    `.reveal { opacity: 0 }` class is one broken bundle away from a blank page.
 *    The cost is a possible flash of the final state before the tween is built,
 *    which `useLayoutEffect` (runs pre-paint) avoids.
 *
 * 2. **`once: true`.** Re-animating on scroll-up is the most common way scroll
 *    animation turns annoying — the user has already read that content and is
 *    now being made to wait for it again.
 *
 * Only `opacity` and `y` (a transform) are animated, so this never triggers
 * layout.
 */
export function Reveal({
  children,
  as = "div",
  className,
  stagger = false,
  delay = 0,
  y = 24,
  immediate = false,
}: RevealProps) {
  const ref = useRef<HTMLElement>(null);
  const Tag = as as unknown as RevealTag;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Checked here rather than at render time so the markup is identical either
    // way — nothing to hydrate-mismatch, and no ScrollTrigger is ever created.
    if (prefersReducedMotion()) return;

    // gsap.context scopes the tween to `el` and gives one-call teardown that
    // also kills the ScrollTrigger — a bare tween's revert() would leave it.
    const ctx = gsap.context(() => {
      const targets = stagger ? Array.from(el.children) : el;
      if (Array.isArray(targets) && targets.length === 0) return;

      gsap.from(targets, {
        y,
        opacity: 0,
        duration: DUR.card,
        ease: EASE.out,
        delay,
        ...(stagger ? { stagger: STAGGER[stagger] } : {}),
        ...(immediate ? {} : { scrollTrigger: { trigger: el, start: REVEAL_START, once: true } }),
      });
    }, el);

    return () => ctx.revert();
  }, [stagger, delay, y, immediate]);

  return (
    <Tag ref={ref} className={className}>
      {children}
    </Tag>
  );
}
