import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { prefersReducedMotion } from "@/lib/motion/reduced-motion";
import type {
  StructureFlowOptions,
  StructureFlowRenderer,
} from "@/lib/motion/structure-flow-renderer";

/**
 * Responsive particle count.
 *
 * Desktop: 8,000 — GPU work drops proportionally, visual density remains intentional.
 * Tablet:  5,000 — scaled for mid-power devices.
 * Mobile:  3,500 — preserved; conservatively sized.
 */
function getParticleCount(): number {
  if (typeof window === "undefined") return 8_000;
  const width = window.innerWidth;
  if (width < 640) return 3_500;
  if (width < 1024) return 5_000;
  return 8_000;
}

/**
 * WebGL capability probe. Called before the dynamic import so we skip the
 * ~600 kB Three.js download entirely on devices that cannot use WebGL.
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
 * QueryVault Structure Flow field.
 *
 * Renders the authoritative Structure Flow particle visualization behind the Hero.
 *
 * Key implementation decisions:
 *
 * 1. **Critical bundle exclusion**: Three.js is loaded via dynamic `import()`
 *    inside `useEffect`. It remains in a separate asynchronous chunk, keeping
 *    the landing page's critical JavaScript minimal.
 *
 * 2. **Post-paint activation (no idle delay)**: Dynamic import begins promptly
 *    after the first paint boundary (two animation frames yield to HTML paint).
 *    This eliminates the previous 2-second idle timeout, so the blue
 *    dots appear within ~300–600ms of page load instead of multiple seconds later.
 *
 * 3. **Immediate distributed field**: The renderer produces a fully populated
 *    field of blue dots on its very first frame before continuing its structural flow.
 *
 * 4. **Short, gentle canvas entrance**: Fades in over 280ms (`transition: opacity 0.28s ease-out`)
 *    without an abrupt visual jump or expensive blur filters.
 *
 * 5. **Unmount safety**: Checked via `cancelled` flag across all async boundaries
 *    (before import, after import, before first frame).
 *
 * 6. **Lifecycle & visibility pausing**: Stops RAF loop while `document.hidden` or
 *    when off-screen, resuming with a single active loop when visible.
 *
 * 7. **Reduced motion & WebGL guards**: Skips download and initialization entirely
 *    when reduced motion is preferred or WebGL is unsupported.
 */
export function QueryVaultField({ className }: { className?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    // SSR guard — never run on the server.
    if (typeof window === "undefined") return;

    // Reduced-motion: skip entirely. No import, no RAF, no canvas.
    if (prefersReducedMotion()) return;

    // WebGL probe: skip the ~600 kB import if the GPU is unavailable.
    if (!canUseWebGl()) return;

    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;

    let cancelled = false;
    let frame = 0;
    let intersecting = true;
    let rendererInstance: StructureFlowRenderer | null = null;
    let raf1 = 0;
    let raf2 = 0;

    // ── Observers ────────────────────────────────────────────────────────

    const resizeObserver = new ResizeObserver(() => {
      if (cancelled || !rendererInstance) return;
      const bounds = host.getBoundingClientRect();
      rendererInstance.resize(bounds.width, bounds.height);
      rendererInstance.render();
    });

    const intersectionObserver = new IntersectionObserver(([entry]) => {
      intersecting = entry?.isIntersecting ?? true;
      if (intersecting && !frame && rendererInstance && !document.hidden) {
        frame = requestAnimationFrame(tick);
      } else if (!intersecting && frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
    });

    resizeObserver.observe(host);
    intersectionObserver.observe(host);

    // ── Animation loop ────────────────────────────────────────────────────

    function tick() {
      if (cancelled || !rendererInstance) {
        frame = 0;
        return;
      }
      rendererInstance.render();
      if (intersecting && !document.hidden) {
        frame = requestAnimationFrame(tick);
      } else {
        frame = 0;
      }
    }

    // ── Visibility change ─────────────────────────────────────────────────

    const onVisibilityChange = () => {
      if (cancelled || !rendererInstance) return;
      if (document.hidden && frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      } else if (!document.hidden && intersecting && !frame) {
        frame = requestAnimationFrame(tick);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    // ── Post-paint activation (prompt import without multi-second idle wait) ──

    // Yield past two animation frames to ensure primary HTML hero content paints first
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(async () => {
        if (cancelled) return;

        try {
          // Dynamic import starts immediately after first paint (~32ms)
          const { createStructureFlowRenderer, STRUCTURE_FLOW_DEFAULTS: defaults } =
            await import("@/lib/motion/structure-flow-renderer");

          if (cancelled) return;

          const particleCount = getParticleCount();
          const options: StructureFlowOptions = { ...defaults, particleCount };
          const optionsRef = { current: options };

          rendererInstance = createStructureFlowRenderer(canvas, () => optionsRef.current);

          if (cancelled) {
            rendererInstance.dispose();
            rendererInstance = null;
            return;
          }

          // Initial size and first frame: renders distributed blue dots immediately
          const bounds = host.getBoundingClientRect();
          rendererInstance.resize(bounds.width, bounds.height);
          rendererInstance.render();

          // Short, smooth 280ms fade-in now that the first frame is ready
          setShown(true);

          if (intersecting && !document.hidden) {
            frame = requestAnimationFrame(tick);
          }
        } catch {
          // WebGL or network error — safe fallback, leaves CSS background visible
        }
      });
    });

    // ── Cleanup ───────────────────────────────────────────────────────────

    return () => {
      cancelled = true;

      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);

      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }

      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);

      if (rendererInstance) {
        rendererInstance.dispose();
        rendererInstance = null;
      }
    };
  }, []);

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-0 z-0 overflow-hidden", className)}
      style={{
        opacity: shown ? 0.85 : 0,
        transition: "opacity 0.28s ease-out",
        maskImage: "linear-gradient(to bottom, black 65%, transparent 100%)",
        WebkitMaskImage: "linear-gradient(to bottom, black 65%, transparent 100%)",
      }}
    >
      <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full" />
    </div>
  );
}
