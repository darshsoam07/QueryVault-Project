import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  WebGLRenderer,
} from "three";

/**
 * Structure Flow — "Flux Vortex" variant, adapted to QueryVault.
 *
 * A sparse field of points on swirl paths around a vertical axis: each point
 * orbits slowly while drifting vertically through a cylinder, wrapping from
 * top to bottom. The motion vocabulary (orbital drift + vertical flow, depth
 * fade toward the camera) follows the ThreeUI Flux Vortex reference; the
 * implementation here is written against three r134, which this repo already
 * carries, and is deliberately much dimmer and slower than the showcase.
 *
 * This module is the ONLY place three.js is imported. It exports a class with
 * a plain imperative surface — create / setRunning / resize / dispose — so
 * the React layer (`src/components/visual/QueryVaultField.tsx`) stays free of
 * renderer internals. All geometry is generated procedurally; nothing is
 * fetched from any external site.
 *
 * Performance contract:
 * - the RAF loop is owned here, and `setRunning(false)` cancels it outright
 *   (no render work, no queued frames) — QueryVaultField calls it on tab hide
 *   and on the hero scrolling out of view;
 * - the loop is a no-op while `document.hidden`, so a stale RAF firing in a
 *   background tab costs nothing;
 * - `dispose()` releases the geometry, material, GL context and canvas, and
 *   is idempotent — the component may not leak a context per navigation.
 */

/** Visual defaults, tuned for "supporting layer", not showcase. */
export interface StructureFlowOptions {
  /** Angular speed multiplier. 0.5 ≈ one slow orbit per ~50s per strand. */
  speed: number;
  /** Base point size in world units before perspective scaling. */
  pointSize: number;
  /** Master opacity, applied in the fragment shader. */
  opacity: number;
  /** Particle count. The component passes a lower value on mobile. */
  count: number;
  /** Base point color as hex — the desaturated cool-gray/cyan signal token. */
  color: number;
}

const STRUCTURE_FLOW_DEFAULTS: StructureFlowOptions = {
  speed: 0.5,
  pointSize: 0.055,
  opacity: 0.28,
  count: 1400,
  color: 0x9bb8c5,
};

/**
 * Fixed uTime for the reduced-motion still frame. Any mid-cycle value works;
 * 12s was picked because the counter-rotating strands are well spread by then.
 */
const STILL_FRAME_TIME = 12;

/** Vertical extent of the vortex cylinder, in world units. */
const FIELD_HEIGHT = 14;
/** Orbit radii sit between these, biased outward so the center stays quiet. */
const RADIUS_MIN = 1.4;
const RADIUS_MAX = 5.2;

const VERTEX_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uSpeed;
  uniform float uPointSize;
  uniform float uPixelRatio;

  attribute float aRadius;    // orbit radius
  attribute float aAngle;     // initial angle (radians)
  attribute float aSeed;      // per-point variation, 0..1
  attribute float aSpin;      // direction + rate of orbit

  varying float vFade;

  void main() {
    // Slow orbit. aSpin carries the sign, so strands counter-rotate.
    float angle = aAngle + uTime * uSpeed * aSpin;

    // Vertical drift with wrap: y rises through the cylinder and folds back.
    // Different seeds desynchronise the strands; the slight radius wobble keeps
    // the cylinder from reading as a rigid shell.
    float y = mod(aSeed * ${FIELD_HEIGHT.toFixed(1)} + uTime * uSpeed * (0.18 + aSeed * 0.22), ${FIELD_HEIGHT.toFixed(1)}) - ${(FIELD_HEIGHT / 2).toFixed(1)};
    float radius = aRadius * (1.0 + 0.06 * sin(uTime * 0.15 * uSpeed + aSeed * 6.2831));

    vec3 position = vec3(cos(angle) * radius, y, sin(angle) * radius);

    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    // Perspective-scaled point size; clamp so distant points never vanish to 0
    // and near ones never bloom into blobs.
    gl_PointSize = clamp(uPointSize * uPixelRatio * (140.0 / -mvPosition.z), 1.0, 7.0);

    // Depth fade: dim toward the far edge of the field, where the eye should
    // least be drawn. Also fades the very near plane so nothing flares past
    // the camera.
    vFade = smoothstep(16.0, 6.0, -mvPosition.z);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;

  varying float vFade;

  void main() {
    // Soft round point: full strength in the middle, gone by the edge.
    // No additive halo, no bloom — the falloff is the entire "glow" budget.
    float d = length(gl_PointCoord - 0.5);
    float alpha = smoothstep(0.5, 0.12, d) * vFade * uOpacity;
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(uColor, alpha);
  }
`;

/** xorshift32 — deterministic field layout, so SSR/CSR and reloads agree. */
function createRng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
}

export class StructureFlowBackground {
  private readonly options: StructureFlowOptions;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera: PerspectiveCamera;
  private readonly geometry: BufferGeometry;
  private readonly material: ShaderMaterial;
  private readonly points: Points;

  private rafId: number | null = null;
  private startMs = 0;
  private elapsedBeforePauseS = 0;
  private disposed = false;

  /** @throws if the WebGL context cannot be created — callers must catch. */
  constructor(canvas: HTMLCanvasElement, options: Partial<StructureFlowOptions> = {}) {
    this.options = { ...STRUCTURE_FLOW_DEFAULTS, ...options };

    this.renderer = new WebGLRenderer({
      canvas,
      alpha: true,
      antialias: false,
      powerPreference: "low-power",
    });
    // Fully transparent clear: the page background shows through, so this
    // canvas never needs to know the page color and never shows a seam.
    this.renderer.setClearColor(0x000000, 0);

    this.camera = new PerspectiveCamera(55, 1, 0.1, 40);
    this.camera.position.z = 9;

    this.geometry = this.buildGeometry();
    this.material = new ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSpeed: { value: this.options.speed },
        uPointSize: { value: this.options.pointSize },
        uOpacity: { value: this.options.opacity },
        uPixelRatio: { value: 1 },
        uColor: { value: this.hexToVec3(this.options.color) },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      // Additive over near-black keeps the points quiet: overlaps brighten
      // slightly instead of stacking opaque dots.
      blending: AdditiveBlending,
    });
    this.points = new Points(this.geometry, this.material);
    // A static tilt reads as depth without any camera motion.
    this.points.rotation.x = 0.32;

    this.scene.add(this.points);
  }

  /** One frame, drawn once — used for reduced motion so the field is still. */
  renderStill(): void {
    this.material.uniforms["uTime"]!.value = STILL_FRAME_TIME;
    this.renderer.render(this.scene, this.camera);
  }

  get running(): boolean {
    return this.rafId !== null;
  }

  setRunning(running: boolean): void {
    if (this.disposed) return;
    if (running === this.running) return;

    if (running) {
      // Resume from the paused clock rather than re-zeroing, so a tab switch
      // doesn't visibly restart the field.
      this.startMs = performance.now() - this.elapsedBeforePauseS * 1000;
      this.rafId = requestAnimationFrame(this.tick);
    } else {
      if (this.rafId !== null) cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  resize(width: number, height: number, pixelRatio: number): void {
    if (this.disposed) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.material.uniforms["uPixelRatio"]!.value = pixelRatio;
    if (!this.running) this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.setRunning(false);
    this.scene.remove(this.points);
    this.geometry.dispose();
    this.material.dispose();
    // Releases the GL context. The canvas element itself is owned (and
    // removed) by the React host, not here.
    this.renderer.dispose();
  }

  private readonly tick = (nowMs: number): void => {
    if (this.disposed) return;
    // Background tabs throttle RAF, but not to zero in every browser — bail
    // out rather than render frames nobody can see.
    if (document.hidden) {
      this.elapsedBeforePauseS = (nowMs - this.startMs) / 1000;
      this.rafId = null;
      return;
    }
    const elapsedS = (nowMs - this.startMs) / 1000;
    this.elapsedBeforePauseS = elapsedS;
    this.material.uniforms["uTime"]!.value = elapsedS;
    this.renderer.render(this.scene, this.camera);
    this.rafId = requestAnimationFrame(this.tick);
  };

  private buildGeometry(): BufferGeometry {
    const { count } = this.options;
    const rng = createRng(0x5156);
    const positions = new Float32Array(count * 3);
    const radii = new Float32Array(count);
    const angles = new Float32Array(count);
    const seeds = new Float32Array(count);
    const spins = new Float32Array(count);

    for (let i = 0; i < count; i += 1) {
      // Position is computed fully in the vertex shader from these four
      // attributes; the position buffer exists only because three needs one.
      radii[i] = RADIUS_MIN + Math.pow(rng(), 0.65) * (RADIUS_MAX - RADIUS_MIN);
      angles[i] = rng() * Math.PI * 2;
      seeds[i] = rng();
      // Counter-rotating strands, each with its own rate.
      spins[i] = (i % 2 === 0 ? 1 : -1) * (0.55 + rng() * 0.7);
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    geometry.setAttribute("aRadius", new BufferAttribute(radii, 1));
    geometry.setAttribute("aAngle", new BufferAttribute(angles, 1));
    geometry.setAttribute("aSeed", new BufferAttribute(seeds, 1));
    geometry.setAttribute("aSpin", new BufferAttribute(spins, 1));
    return geometry;
  }

  private hexToVec3(hex: number): { x: number; y: number; z: number } {
    return {
      x: ((hex >> 16) & 0xff) / 255,
      y: ((hex >> 8) & 0xff) / 255,
      z: (hex & 0xff) / 255,
    };
  }
}
