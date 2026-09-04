import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { prefersReducedMotion } from "@/lib/motion/reduced-motion";
import {
  createStructureFlowRenderer,
  STRUCTURE_FLOW_DEFAULTS,
  type StructureFlowOptions,
} from "@/lib/motion/structure-flow-renderer";

/**
 * Responsive particle count scaled for device performance while preserving visual structure.
 */
function getParticleCount(): number {
  if (typeof window === "undefined") return STRUCTURE_FLOW_DEFAULTS.particleCount;
  const width = window.innerWidth;
  if (width < 640) return 3_500;
  if (width < 1024) return 7_000;
  return 12_000;
}

/**
 * WebGL capability probe.
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
 * - SSR safe (WebGL isolated in useEffect)
 * - Controlled RAF with visibility change pause & IntersectionObserver
 * - Responsive particle allocation
 * - Reduced motion support (single static frame)
 */
export function QueryVaultField({ className }: { className?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    if (!canUseWebGl()) return;

    const reducedMotion = prefersReducedMotion();
    const particleCount = getParticleCount();

    const options: StructureFlowOptions = {
      ...STRUCTURE_FLOW_DEFAULTS,
      particleCount,
    };
    const optionsRef = { current: options };

    const rendererInstance = createStructureFlowRenderer(canvas, () => optionsRef.current);

    let frame = 0;
    let visible = true;

    const resize = () => {
      const bounds = host.getBoundingClientRect();
      rendererInstance.resize(bounds.width, bounds.height);
      rendererInstance.render();
    };

    const tick = () => {
      rendererInstance.render();
      frame = visible && !document.hidden ? requestAnimationFrame(tick) : 0;
    };

    const resizeObserver = new ResizeObserver(resize);

    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
      if (visible && !frame && !reducedMotion) frame = requestAnimationFrame(tick);
      if (!visible && frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
    });

    resizeObserver.observe(host);
    intersection.observe(host);
    resize();

    // Initial render
    rendererInstance.render();

    if (!reducedMotion) {
      frame = requestAnimationFrame(tick);
    }

    setReady(true);

    const onVisibilityChange = () => {
      if (reducedMotion) return;
      if (document.hidden && frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      } else if (!document.hidden && visible && !frame) {
        frame = requestAnimationFrame(tick);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (frame) cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      intersection.disconnect();
      rendererInstance.dispose();
    };
  }, []);

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-0 z-0 overflow-hidden", className)}
      style={{
        opacity: ready ? 0.75 : 0,
        transition: "opacity 0.6s ease-out",
        maskImage: "linear-gradient(to bottom, black 65%, transparent 100%)",
        WebkitMaskImage: "linear-gradient(to bottom, black 65%, transparent 100%)",
      }}
    >
      <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full" />
    </div>
  );
}
