import type { VantaEffect, VantaFogOptions } from "vanta/dist/vanta.fog.min";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { prefersReducedMotion } from "@/lib/motion/reduced-motion";

/**
 * Palette, derived from the `oklch` design tokens in `src/styles.css` by
 * conversion (Oklab → linear sRGB → gamma), not by eye. Vanta needs hex numbers
 * because it feeds them straight into `new THREE.Color()` and on into `vec3`
 * shader uniforms.
 *
 * FOG's own defaults are a warm orange/red/blue that has nothing to do with this
 * product, so all four are overridden — none of them can be left alone.
 *
 * The highlight and midtone are deliberately *dimmed* versions of the brand
 * colours rather than the tokens themselves. `--amethyst` (#8b5df4) against
 * `--foreground` is only 3.9:1, which is under the 4.5:1 body-text threshold;
 * the values below sit at 6.0:1 and 4.2:1 before the container's opacity is
 * applied, and comfortably past it after. The fog must never be the reason a
 * headline is hard to read.
 */
const PALETTE = {
  /** Dimmed `--amethyst` — oklch(0.50 0.18 293). Brightest pixel the fog can produce. */
  highlightColor: 0x6b45be,
  /** Dimmed `--cyan` — oklch(0.55 0.10 205). Keeps the cyan→amethyst brand sweep. */
  midtoneColor: 0x00828d,
  /** Deep violet — oklch(0.26 0.12 293). Reads as shadow, not as a third hue. */
  lowlightColor: 0x290e57,
  /** `--background` exactly — oklch(0.145 0.006 264). The shader is opaque, so
   *  this is what the canvas resolves to wherever the fog is thin, and it has to
   *  match the page or the hero shows a visible seam. */
  baseColor: 0x090a0d,
} as const;

/**
 * Vanta advances its shader clock with `this.t2 += (this.options.speed || 1) * dt`.
 *
 * The `|| 1` is why freezing cannot be done with `speed: 0` — zero is falsy, so
 * it would fall back to full speed, i.e. the exact opposite of the intent. A
 * small non-zero value is the only way in, and 1e-4 advances the clock by about
 * one frame every four hours.
 */
const FROZEN_SPEED = 0.0001;
const ACTIVE_SPEED = 0.7;

/**
 * Can this browser actually give us a WebGL context?
 *
 * Feature-detecting `window.WebGLRenderingContext` is not enough — the
 * constructor exists on machines where context creation still fails (blocklisted
 * drivers, GPU process crashed, too many live contexts). Vanta constructs its
 * renderer *outside* its own try/catch, so a failure there throws out of the
 * `FOG()` call rather than degrading.
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
 * Dig the FOG factory out of whatever shape the interop hands back.
 *
 * `vanta.fog.min.js` is a webpack UMD bundle whose `module.exports` is *itself*
 * an `__esModule`-tagged namespace — `{ __esModule: true, default: FOG }`. So
 * whether `import()` yields `{ default: FOG }` or `{ default: { default: FOG } }`
 * depends on how many times the CJS→ESM interop honours that tag, and Vite's dev
 * optimizer (esbuild) and the production Rollup build do not agree: dev arrives
 * double-wrapped and destructuring `{ default: FOG }` gets an object, not a
 * function.
 *
 * Unwrapping until a function falls out is shorter than either pinning one shape
 * (which breaks in the other environment) or adding an `optimizeDeps` entry to
 * force them to match, and it cannot silently regress if Vite changes its mind.
 */
function resolveFogFactory(mod: unknown): ((options: VantaFogOptions) => VantaEffect) | null {
  let candidate: unknown = mod;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof candidate === "function") {
      return candidate as (options: VantaFogOptions) => VantaEffect;
    }
    if (candidate !== null && typeof candidate === "object" && "default" in candidate) {
      candidate = (candidate as { default: unknown }).default;
      continue;
    }
    return null;
  }
  return null;
}

/**
 * The Vanta FOG hero background.
 *
 * Confined to one component on the public marketing surface. The brief is
 * explicit that WebGL backgrounds do not belong on dashboards, forms, or
 * accessibility-critical interfaces, and keeping it here also keeps three.js out
 * of the workspace bundle entirely — `three` and `vanta` are only ever reached
 * through the dynamic `import()` below, so they land in a lazily fetched chunk
 * that `/chat` and `/admin` never request.
 *
 * The element underneath keeps its `grid-void` gradient, which is the fallback
 * for every path where the canvas is not created: reduced motion, no WebGL, or
 * an outright init failure. Nothing about the hero depends on this rendering.
 */
export function VantaFog({ className }: { className?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  /** Drives the fade-in, so the canvas does not pop in when its chunk arrives. */
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (prefersReducedMotion() || !canUseWebGl()) return;

    let effect: VantaEffect | null = null;
    let cancelled = false;

    /**
     * `mouseControls` and `touchControls` are off, and not only for restraint:
     * Vanta attaches window-level `scroll` + `mousemove` (or `touchmove`)
     * listeners when they are on. On a page running Lenis that is extra work on
     * the hottest path in the app, to make fog wobble toward the cursor.
     */
    void (async () => {
      try {
        const [fogModule, { THREE_SUBSET }] = await Promise.all([
          import("vanta/dist/vanta.fog.min"),
          import("@/lib/motion/three-subset"),
        ]);
        if (cancelled) return;

        const FOG = resolveFogFactory(fogModule);
        if (!FOG) throw new TypeError("vanta.fog.min exported no callable factory");

        effect = FOG({
          el: host,
          THREE: THREE_SUBSET,
          ...PALETTE,
          /** Softens the fbm amplitude. Slightly above default: fewer hard edges. */
          blurFactor: 0.62,
          /** Below 1 so the forms are larger and calmer than the default churn. */
          zoom: 0.9,
          speed: ACTIVE_SPEED,
          /** Renders at 1/scale and upscales. Free on a blurry gradient. */
          scale: 2,
          scaleMobile: 4,
          mouseControls: false,
          touchControls: false,
          gyroControls: false,
        });
        setReady(true);
      } catch (error) {
        // Vanta is unmaintained and this is a decorative layer. Log it and let
        // the gradient underneath stand in; never let it take the hero down.
        console.warn("[VantaFog] falling back to the static gradient", error);
      }
    })();

    /**
     * Freeze while the tab is hidden.
     *
     * Partial by Vanta's design, and worth being precise about: there is no
     * `pause()`, and `animationLoop()` re-queues its `requestAnimationFrame`
     * unconditionally. This stops the shader clock and therefore all visible
     * motion; the RAF callback keeps firing as a near-no-op, which browsers
     * already throttle hard in background tabs. Destroy-and-reinitialise would
     * stop it completely but at the cost of the fog pattern jumping every time
     * the user comes back, which is a worse trade.
     *
     * Vanta's own `isOnScreen()` gate separately skips render work once the hero
     * has scrolled out of view, so the common case is already handled.
     */
    const onVisibilityChange = () => {
      effect?.setOptions({ speed: document.hidden ? FROZEN_SPEED : ACTIVE_SPEED });
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      // Releases the WebGL context, removes the canvas, cancels the RAF loop and
      // detaches Vanta's window listeners. Skipping it leaks a live GL context
      // per client-side navigation away from the landing page.
      effect?.destroy();
      effect = null;
    };
  }, []);

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      className={cn(
        // Purely decorative and never interactive — the hero's CTAs sit above it.
        "pointer-events-none absolute inset-0 overflow-hidden",
        // Held well back. The fog is atmosphere; at full strength it competes
        // with the copy for attention and wins, which is the wrong outcome.
        "opacity-0 transition-opacity duration-1000 ease-out",
        ready && "opacity-55",
        className,
      )}
      style={{
        // Fades the canvas out toward the bottom so it dissolves into the page
        // instead of ending on a hard horizontal line at the hero boundary.
        maskImage: "linear-gradient(to bottom, black 55%, transparent 100%)",
        WebkitMaskImage: "linear-gradient(to bottom, black 55%, transparent 100%)",
      }}
    />
  );
}
