import {
  Camera,
  Color,
  Mesh,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  TextureLoader,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";

/**
 * The exact — and complete — three.js surface Vanta's FOG effect touches.
 *
 * Verified by reading `node_modules/vanta/dist/vanta.fog.min.js` rather than by
 * trusting the docs. Vanta keeps two module-level aliases for the namespace and
 * both are reassigned from `options.THREE`:
 *
 * - the base class (`initThree`) uses `Scene` and `WebGLRenderer`;
 * - the shader base (`initBasicShader`) uses `Camera`, `Color`, `Mesh`,
 *   `PlaneGeometry`, `ShaderMaterial`, `TextureLoader`, `Vector2`, `Vector3`.
 *
 * There are **zero** bracket/dynamic property reads on either alias, so this is
 * provably exhaustive — a hand-built namespace cannot come up short at runtime
 * the way it could if Vanta did `THREE[someName]` anywhere.
 *
 * Why bother instead of `import * as THREE from "three"`: this module holds
 * *static* named imports, so when it is pulled in through a dynamic `import()`
 * Rollup can drop the 448 other exports of three's single 1.1 MB ESM bundle.
 * A namespace object would force the whole thing into the chunk.
 *
 * Side effects to be aware of — Vanta mutates globals when FOG initialises:
 * it defines `Number.prototype.clamp` and adds `toVector()` to
 * `Color.prototype`. Harmless, but it means the namespace below is not
 * pristine after first use.
 */
export const THREE_SUBSET = {
  Camera,
  Color,
  Mesh,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  TextureLoader,
  Vector2,
  Vector3,
  WebGLRenderer,
} as const;
