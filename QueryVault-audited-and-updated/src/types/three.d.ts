/**
 * Minimal type surface for `three@0.134.0`, which ships no `.d.ts` of its own.
 *
 * `@types/three` is deliberately not installed. The app uses three in two
 * places: Vanta's fog shader (via `three-subset.ts`) and the Structure Flow
 * particle renderer (`structure-flow-renderer.ts`). Both touch a small, fixed
 * set of constructors, so the honest contract is "these symbols exist and are
 * constructible", and that is all that is declared here.
 *
 * If three ever becomes a first-class dependency here, delete this file and
 * install `@types/three` at the matching version instead.
 */
declare module "three" {
  // ── Vanta subset ─────────────────────────────────────────────────────
  export class Camera {
    position: { x: number; y: number; z: number };
  }
  export class Color {
    constructor(color?: number | string);
  }
  export class Mesh {
    constructor(geometry?: unknown, material?: unknown);
  }
  export class PlaneGeometry {
    constructor(width?: number, height?: number);
  }
  export class Scene {
    children: unknown[];
    add(object: unknown): void;
  }
  export class ShaderMaterial {
    constructor(parameters?: Record<string, unknown>);
  }
  export class TextureLoader {
    load(url: string): unknown;
  }
  export class Vector2 {
    constructor(x?: number, y?: number);
    x: number;
    y: number;
  }
  export class Vector3 {
    constructor(x?: number, y?: number, z?: number);
  }
  export class WebGLRenderer {
    constructor(parameters?: { canvas?: HTMLCanvasElement; alpha?: boolean; antialias?: boolean });
    domElement: HTMLCanvasElement;
    render(scene: Scene, camera: Camera): void;
    setSize(width: number, height: number, updateStyle?: boolean): void;
    setPixelRatio(value: number): void;
    setClearColor(color?: number | string, alpha?: number): void;
    dispose(): void;
  }

  // ── Structure Flow renderer subset ───────────────────────────────────
  export class PerspectiveCamera extends Camera {
    constructor(fov?: number, aspect?: number, near?: number, far?: number);
    aspect: number;
    updateProjectionMatrix(): void;
  }
  export class BufferGeometry {
    setAttribute(name: string, attribute: BufferAttribute): void;
    dispose(): void;
  }
  export class BufferAttribute {
    constructor(array: ArrayLike<number>, itemSize: number);
  }
  export class Points {
    rotation: { x: number; y: number; z: number };
    constructor(geometry?: BufferGeometry, material?: PointsMaterial);
  }
  export class PointsMaterial {
    size: number;
    opacity: number;
    constructor(parameters?: {
      size?: number;
      color?: number;
      transparent?: boolean;
      opacity?: number;
      blending?: number;
      depthWrite?: boolean;
    });
    dispose(): void;
  }

  /** Three.js additive blending constant. */
  export const AdditiveBlending: number;
}
