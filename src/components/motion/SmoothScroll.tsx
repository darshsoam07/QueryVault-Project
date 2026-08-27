import type { LenisOptions } from "lenis";
import { ReactLenis, useLenis } from "lenis/react";
import { useEffect, useState, type ReactNode } from "react";

import { gsap, ScrollTrigger } from "@/lib/motion/gsap";
import { prefersReducedMotion, REDUCED_MOTION_QUERY } from "@/lib/motion/reduced-motion";

/**
 * Module-level constant, not an inline object literal.
 *
 * `ReactLenis` keys its init effect on `JSON.stringify(options)`, so a fresh
 * object each render is fine in principle — but a stable reference makes it
 * obvious that Lenis is constructed exactly once per mount.
 */
const LENIS_OPTIONS: LenisOptions = {
  /**
   * Frame-rate-independent damping factor. 0.1 is Lenis's own default and is
   * about the highest value that still reads as "the page has weight" rather
   * than "the page is behind my input".
   *
   * Deliberately *without* `duration`. The two are mutually exclusive, and not
   * symmetrically so: Lenis's `Animate.advance()` checks `duration && easing`
   * first and only falls through to the lerp branch if that is unset, and the
   * constructor auto-fills `easing` the moment a numeric `duration` is passed.
   * So setting both silently discards `lerp` and turns every wheel tick into a
   * fixed-length eased animation — which is precisely the "Lenis feels laggy"
   * complaint. Lerp-only tracks input velocity instead.
   */
  lerp: 0.1,
  smoothWheel: true,
  /**
   * Leave touch scrolling entirely native.
   *
   * The brief says to disable smooth scrolling on mobile if performance drops;
   * this resolves that pre-emptively. Mobile browsers already have excellent
   * momentum scrolling that is composited off the main thread, and `syncTouch`
   * replaces it with a JS-driven approximation. There is nothing to gain and a
   * frame budget to lose.
   */
  syncTouch: false,
  /**
   * Hand the clock to GSAP — see `LenisGsapBridge`.
   *
   * This must be set through `options`, not the `autoRaf` prop: `ReactLenis`
   * resolves `autoRaf: options?.autoRaf ?? autoRaf` where the *prop* defaults to
   * `true`, so omitting it here would start a second RAF loop even though Lenis
   * core defaults `autoRaf` to `false`. Two independent RAF loops is the usual
   * cause of stuttery smooth scroll.
   */
  autoRaf: false,
};

/**
 * Makes GSAP's ticker the single clock for both libraries, and tells
 * ScrollTrigger about Lenis's virtual scroll position.
 *
 * Without the `scroll` → `ScrollTrigger.update` link, ScrollTrigger reads the
 * native scroll position, which Lenis updates in discrete jumps — triggers fire
 * late and pinning judders.
 */
function LenisGsapBridge() {
  const lenis = useLenis();

  useEffect(() => {
    // `undefined` on the first render: ReactLenis constructs the instance in its
    // own effect and publishes it via context, so this runs again once it exists.
    if (!lenis) return;

    lenis.on("scroll", ScrollTrigger.update);

    const tick = (time: number) => {
      // gsap.ticker reports seconds, lenis.raf expects milliseconds.
      lenis.raf(time * 1000);
    };
    gsap.ticker.add(tick);

    // Lag smoothing clamps the delta after a long frame. Lenis integrates real
    // elapsed time, so a clamped delta desyncs its animated position from the
    // actual scroll offset and shows up as a snap once the tab regains focus.
    gsap.ticker.lagSmoothing(0);

    return () => {
      lenis.off("scroll", ScrollTrigger.update);
      gsap.ticker.remove(tick);
      gsap.ticker.lagSmoothing(500, 33); // GSAP's defaults.
    };
  }, [lenis]);

  return null;
}

/**
 * Window-level smooth scrolling for the public surfaces (`/`, `/reference`,
 * `/auth`) via `PublicShell`.
 *
 * Not mounted in `__root.tsx` on purpose. The root route also renders the
 * authed workspace, where `src/routes/chat.tsx` is `h-screen overflow-hidden`
 * with its own nested scroll containers — window-level Lenis would be inert
 * there at best, and at worst would fight the chat transcript's stick-to-bottom
 * autoscroll.
 *
 * Under `prefers-reduced-motion` no Lenis instance is created at all. That is a
 * stronger guarantee than Lenis's own `respectReducedMotion` (which merely
 * forces `lerp: 1`): no RAF loop starts, no wheel events are intercepted, and
 * scrolling is exactly what the browser does natively.
 */
export function SmoothScroll({ children }: { children: ReactNode }) {
  /**
   * Tri-state: `null` until the media query has been read on the client.
   *
   * While `null` we render `children` bare, which is byte-identical to the
   * server render — so hydration cannot mismatch. Lenis then mounts after the
   * first effect. Nothing is lost by the one-tick delay, because ReactLenis
   * constructs its instance in an effect regardless.
   */
  const [reduced, setReduced] = useState<boolean | null>(null);

  useEffect(() => {
    setReduced(prefersReducedMotion());
    if (typeof window.matchMedia !== "function") return;
    // Toggling the OS setting should tear the instance down, not wait for a reload.
    const mql = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = () => setReduced(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  if (reduced !== false) return <>{children}</>;

  return (
    <ReactLenis root options={LENIS_OPTIONS}>
      <LenisGsapBridge />
      {children}
    </ReactLenis>
  );
}
