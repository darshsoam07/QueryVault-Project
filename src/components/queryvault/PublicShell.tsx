import { Link } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { SmoothScroll } from "@/components/motion/SmoothScroll";
import { VaultMark, Wordmark } from "@/components/queryvault/brand";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { gsap } from "@/lib/motion/gsap";
import { prefersReducedMotion } from "@/lib/motion/reduced-motion";
import { DUR, EASE, STAGGER } from "@/lib/motion/tokens";
import { cn } from "@/lib/utils";

/**
 * Sticky site header for the public surfaces.
 *
 * The background only appears once the page has scrolled: over the hero it would
 * cut a hard band across the fog, and at the top of the page there is nothing to
 * separate the header from.
 */
function SiteHeader() {
  const { session } = useAuth();
  const headerRef = useRef<HTMLElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);

  /**
   * A sentinel + IntersectionObserver rather than a scroll listener.
   *
   * Two reasons. It puts no work on the scroll path at all, which matters on a
   * page running Lenis; and it is indifferent to *how* the page scrolled, so it
   * behaves identically whether Lenis is mounted or the user has reduced motion
   * on and scrolling is native. A `useLenis` callback would silently never fire
   * in the second case.
   */
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      ([entry]) => setScrolled(!(entry?.isIntersecting ?? true)),
      { threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    if (prefersReducedMotion()) return;

    const ctx = gsap.context(() => {
      // Brand and nav arrive together but not in lockstep — a small stagger
      // reads as one movement rather than two things happening at once.
      gsap.from("[data-header-item]", {
        y: -10,
        opacity: 0,
        duration: DUR.page,
        ease: EASE.out,
        stagger: STAGGER.normal,
      });
    }, el);

    return () => ctx.revert();
  }, []);

  return (
    <>
      {/* Zero-height probe: once this leaves the viewport, the page has scrolled. */}
      <div ref={sentinelRef} aria-hidden="true" className="absolute top-0 h-px w-full" />
      <header
        ref={headerRef}
        className="sticky top-0 z-40 border-b border-transparent transition-colors duration-300"
      >
        {/* Separate layer so only `opacity` transitions — cross-fading a
            backdrop-filter directly is expensive and janks on scroll. */}
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-0 border-b border-border/60 bg-background/70 backdrop-blur-md",
            "opacity-0 transition-opacity duration-300 ease-out",
            scrolled && "opacity-100",
          )}
        />
        <div className="relative mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <Link to="/" data-header-item className="flex items-center gap-2">
            <VaultMark />
            <Wordmark />
          </Link>
          <nav data-header-item className="flex items-center gap-2">
            <Button variant="ghost" size="sm" asChild>
              <Link to="/reference">Python reference</Link>
            </Button>
            <Button
              size="sm"
              asChild
              className="bg-foreground text-background font-medium hover:bg-foreground/90 transition-colors"
            >
              <Link to={session ? "/chat" : "/auth"}>{session ? "Open workspace" : "Sign in"}</Link>
            </Button>
          </nav>
        </div>
      </header>
    </>
  );
}

/**
 * Wrapper for the public surfaces: `/`, `/reference`, `/auth`.
 *
 * This is where Lenis is mounted — deliberately *not* in `__root.tsx`, which
 * also renders the authed workspace. `src/routes/chat.tsx` is
 * `h-screen overflow-hidden` with its own nested scrollers, so window-level
 * smooth scroll would be inert there and would fight the chat transcript's
 * stick-to-bottom behaviour. Scoping it here also means `/chat` and `/admin`
 * never pay for Lenis at all.
 */
export function PublicShell({
  children,
  className,
  header = true,
}: {
  children: ReactNode;
  className?: string;
  /** Set false for surfaces that provide their own chrome (e.g. `/auth`). */
  header?: boolean;
}) {
  return (
    <SmoothScroll>
      <div className={cn("grid-void relative min-h-screen", className)}>
        {header && <SiteHeader />}
        <main>{children}</main>
      </div>
    </SmoothScroll>
  );
}
