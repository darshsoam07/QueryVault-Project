/**
 * Minimal type surface for `three@0.134.0`, which ships no `.d.ts` of its own.
 *
 * `@types/three` is deliberately not installed. Nothing in this app uses three
 * directly — it exists solely to satisfy Vanta, which reads a fixed set of
 * constructors off the namespace it is handed (see `src/lib/motion/three-subset.ts`)
 * and never inspects their instances from our side. So the honest contract is
 * "these ten symbols exist and are constructible", and that is all that is
 * declared. Pulling in the full three typings would be several megabytes of
 * declarations describing an API this codebase never calls.
 *
 * If three ever becomes a first-class dependency here, delete this file and
 * install `@types/three` at the matching version instead.
 */
declare module "three" {
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
    constructor(parameters?: { alpha?: boolean; antialias?: boolean });
    domElement: HTMLCanvasElement;
    render(scene: Scene, camera: Camera): void;
    setSize(width: number, height: number): void;
    setPixelRatio(value: number): void;
    setClearColor(color?: number | string, alpha?: number): void;
  }
}
