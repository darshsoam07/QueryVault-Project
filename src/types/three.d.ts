/**
 * Minimal type surface for `three@0.134.0`, which ships no `.d.ts` of its own.
 *
 * `@types/three` is deliberately not installed. Three is reached from exactly
 * one place — the structure-flow renderer in `src/shaders/structure-flow/` —
 * which needs scene/points/shader plumbing and nothing else. The honest
 * contract is "these symbols exist and behave as declared below", written
 * against the r134 API that code actually calls. Pulling in the full three
 * typings would be several megabytes of declarations describing an API this
 * codebase never touches.
 *
 * If three ever becomes a first-class dependency here, delete this file and
 * install `@types/three` at the matching version instead.
 */
declare module "three" {
  export class Camera {
    position: { x: number; y: number; z: number };
  }

  export class PerspectiveCamera extends Camera {
    constructor(fov?: number, aspect?: number, near?: number, far?: number);
    aspect: number;
    updateProjectionMatrix(): void;
  }

  export class Color {
    constructor(color?: number | string);
  }

  export class BufferAttribute {
    constructor(array: ArrayLike<number>, itemSize: number);
  }

  export class BufferGeometry {
    setAttribute(name: string, attribute: BufferAttribute): void;
    dispose(): void;
  }

  export class Material {
    dispose(): void;
  }

  export class ShaderMaterial extends Material {
    constructor(parameters?: {
      uniforms?: Record<string, { value: unknown }>;
      vertexShader?: string;
      fragmentShader?: string;
      transparent?: boolean;
      depthWrite?: boolean;
      depthTest?: boolean;
      blending?: number;
    });
    uniforms: Record<string, { value: unknown }>;
  }

  export class Points {
    constructor(geometry?: BufferGeometry, material?: Material);
    rotation: { x: number; y: number; z: number };
  }

  export class Scene {
    children: unknown[];
    add(object: unknown): void;
    remove(object: unknown): void;
  }

  export class WebGLRenderer {
    constructor(parameters?: {
      canvas?: HTMLCanvasElement;
      alpha?: boolean;
      antialias?: boolean;
      powerPreference?: string;
    });
    domElement: HTMLCanvasElement;
    render(scene: Scene, camera: Camera): void;
    setSize(width: number, height: number, updateStyle?: boolean): void;
    setPixelRatio(value: number): void;
    setClearColor(color?: number | string, alpha?: number): void;
    dispose(): void;
  }

  export const AdditiveBlending: number;
}
