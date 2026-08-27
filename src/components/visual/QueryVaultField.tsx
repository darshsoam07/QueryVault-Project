import { useEffect, useRef, useState } from "react";

import { prefersReducedMotion } from "@/lib/motion/reduced-motion";
import { cn } from "@/lib/utils";
// Type-only import: erased at build time, so three stays out of the eager
// bundle. The real module is loaded through the dynamic import() below.
import type { StructureFlowBackground } from "@/shaders/structure-flow/StructureFlowBackground";

/**
 * Can this browser actually give us a WebGL context?
 *
 * Feature-detecting `window.WebGLRenderingContext` is not enough — the
 * constructor exists on machines where context creation still fails
 * (blocklisted drivers, crashed GPU process, too many live contexts).
 */
function canUseWebGl(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

/**
 * The QueryVault structure-flow field: a slow, dim particle vortex behind the
 * landing hero.
 *
 * This component is the only application-facing handle on the Structure Flow
 * implementation (`src/shaders/structure-flow/`). It owns the lifecycle so no
 * page has to:
 *
 * - **Lazy**: the renderer and three.js arrive via dynamic `import()`, in a
 *   chunk `/chat` and `/admin` never request.
 * - **Single renderer**: one instance per mounted host, created once, never
 *   recreated on re-render.
 * - **Paused when invisible**: an IntersectionObserver stops the RAF loop once
 *   the hero leaves the viewport, and `visibilitychange` stops it in a hidden
 *   tab (the loop additionally self-terminates if a throttled frame slips
 *   through while hidden).
 * - **Reduced motion**: no RAF loop at all — one static frame is drawn so the
 *   composition (dark field, faint structure) survives without motion.
 * - **Failure-proof**: no WebGL, or any init error, leaves the static
 *   graphite layer underneath; nothing about the page depends on the canvas.
 * - **Disposed on unmount**: geometry, material and GL context are released,
 *   so client-side navigation away from `/` leaks nothing.
 */
export function QueryVaultField({ className }: { className?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** Drives the fade-in, so the canvas does not pop in when its chunk arrives. */
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    if (!canUseWebGl()) return;

    const reduced = prefersReducedMotion();
    /** Sparser field and a tighter pixel-ratio cap on small viewports. */
    const smallViewport = window.innerWidth < 640;
    const pixelRatioCap = smallViewport ? 1.5 : 2;

    let field: StructureFlowBackground | null = null;
    let cancelled = false;
    let inView = true;

    const applyRunning = () => {
      field?.setRunning(!reduced && inView && !document.hidden);
    };

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!field || !entry) return;
      const { width, height } = entry.contentRect;
      if (width === 0 || height === 0) return;
      field.resize(width, height, Math.min(window.devicePixelRatio || 1, pixelRatioCap));
    });
    resizeObserver.observe(host);

    const intersectionObserver = new IntersectionObserver(
      ([entry]) => {
        inView = entry?.isIntersecting ?? true;
        applyRunning();
      },
      { threshold: 0 },
    );
    intersectionObserver.observe(host);

    document.addEventListener("visibilitychange", applyRunning);

    void (async () => {
      try {
        const mod = await import("@/shaders/structure-flow/StructureFlowBackground");
        if (cancelled) return;

        field = new mod.StructureFlowBackground(canvas, {
          count: smallViewport ? 700 : 1400,
        });

        const rect = host.getBoundingClientRect();
        field.resize(
          rect.width,
          rect.height,
          Math.min(window.devicePixelRatio || 1, pixelRatioCap),
        );

        if (reduced) {
          // Composition without motion: a single drawn frame, re-rendered by
          // resize() above if the viewport changes.
          field.renderStill();
        } else {
          applyRunning();
        }
        setReady(true);
      } catch (error) {
        // Decorative layer only. Log it and let the static layer underneath
        // stand in; the hero must never go down with the canvas.
        console.warn("[QueryVaultField] falling back to the static background", error);
      }
    })();

    return () => {
      cancelled = true;
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      document.removeEventListener("visibilitychange", applyRunning);
      // Releases geometry, material and the WebGL context; the canvas element
      // itself is removed by React.
      field?.dispose();
      field = null;
    };
  }, []);

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      className={cn(
        // Purely decorative and never interactive — the hero's CTAs sit above it.
        "pointer-events-none absolute inset-0 overflow-hidden",
        "opacity-0 transition-opacity duration-1000 ease-out",
        ready && "opacity-100",
        className,
      )}
      style={{
        // Static graphite layer: always present, and the entire background when
        // the canvas never initialises. Neutral off-white tint, no color wash.
        background:
          "radial-gradient(ellipse 70% 55% at 50% 38%, color-mix(in oklab, var(--foreground) 5%, transparent), transparent 72%)",
        // Dissolve into the page instead of ending on a hard line at the hero boundary.
        maskImage: "linear-gradient(to bottom, black 55%, transparent 100%)",
        WebkitMaskImage: "linear-gradient(to bottom, black 55%, transparent 100%)",
      }}
    >
      {/* The renderer sets the canvas buffer size with updateStyle=false;
          CSS owns layout size. */}
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}
