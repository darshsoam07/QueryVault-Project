/**
 * Types for `vanta@0.5.24`, which ships no `.d.ts` and has no `exports` map, so
 * effects are reached by deep import into `dist/`.
 *
 * Declared against what upstream `src/_base.js` and `src/_shaderBase.js`
 * actually implement, not against what the docs imply. In particular there is
 * **no** `pause()` / `play()` — `setOptions`, `resize`, `restart` and `destroy`
 * are the entire instance API, which is why VantaFog freezes the effect by
 * setting `speed: 0` rather than pausing it.
 *
 * The bundle is webpack UMD with `__esModule: true` and a single `default`
 * export, so the effect factory arrives as `mod.default` through Vite's CJS
 * interop.
 */
declare module "vanta/dist/vanta.fog.min" {
  /**
   * Colors are hex numbers (`0xrrggbb`), not CSS strings — Vanta feeds them
   * straight into `new THREE.Color(...)` and on into shader uniforms.
   */
  export interface VantaFogOptions {
    el: HTMLElement;
    /**
     * The three.js namespace to render with. Vanta reads only a fixed set of
     * constructors off this object, so a hand-built partial namespace is valid
     * and lets the bundler tree-shake the rest of three away.
     */
    THREE: unknown;
    highlightColor?: number;
    midtoneColor?: number;
    lowlightColor?: number;
    baseColor?: number;
    /** Seeds the fbm amplitude in the fragment shader. Higher = softer. */
    blurFactor?: number;
    /** Scales the shader's normalised coordinates. Lower = larger, calmer forms. */
    zoom?: number;
    speed?: number;
    /** Inverse render resolution: the canvas is drawn at 1/scale and upscaled. */
    scale?: number;
    scaleMobile?: number;
    mouseControls?: boolean;
    touchControls?: boolean;
    gyroControls?: boolean;
    minHeight?: number;
    minWidth?: number;
  }

  export interface VantaEffect {
    setOptions(options: Partial<VantaFogOptions>): void;
    resize(): void;
    restart(): void;
    destroy(): void;
  }

  const FOG: (options: VantaFogOptions) => VantaEffect;
  export default FOG;
}
