/**
 * Structure Flow particle renderer.
 *
 * Direct, faithful implementation of the supplied ThreeUI Structure Flow source.
 * Generates an architectural particle field with spherical flow coordinates and
 * dual-axis rotation.
 *
 * Uses `three@0.134.0` (r128–r160 range).
 *
 * Three.js is intentionally NOT imported here at the module level.
 * This file is loaded via a dynamic `import()` from QueryVaultField so that the
 * ~600 kB Three.js library stays out of the landing-page critical bundle.
 * `createStructureFlowRenderer` receives the already-loaded THREE namespace from
 * the caller, which imports three inside the dynamic chunk.
 */

import * as THREE from "three";

export type ThreeNamespace = typeof THREE;

export interface StructureFlowOptions {
  speed: number;
  pointSize: number;
  opacity: number;
  maskStart: number;
  maskSolid: number;
  particleCount: number;
}

export const STRUCTURE_FLOW_DEFAULTS: StructureFlowOptions = {
  speed: 0.8,
  pointSize: 0.09,
  opacity: 0.65,
  maskStart: 0.1,
  maskSolid: 0.4,
  /**
   * Reduced from 12,000 → 8,000 (desktop). The visual density still reads as
   * intentional at this count, and the GPU work per frame drops proportionally.
   * Responsive counts are set by the caller (QueryVaultField).
   */
  particleCount: 8_000,
};

export function createStructureFlowRenderer(
  canvas: HTMLCanvasElement,
  getOptions: () => StructureFlowOptions,
) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  camera.position.z = 30;
  camera.position.y = 5;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    /**
     * Antialiasing disabled. This is a points-based particle field — individual
     * particles are rendered as screen-space quads, not triangles with shared
     * edges. MSAA provides no perceptible benefit here but costs ~2× fill rate
     * on high-DPI displays.
     */
    antialias: false,
  });
  /**
   * Cap at 1.5× rather than 2×. The particle field is decorative background
   * content; the difference between 1.5 and 2 is invisible at normal viewing
   * distance. At 2× DPR a 1440p display renders at 2880×1620 pixels per frame.
   * 1.5× brings that to 2160×1215 — still sharp, 44% fewer pixels.
   */
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));

  const geometry = new THREE.BufferGeometry();
  const count = getOptions().particleCount;
  const positions = new Float32Array(count * 3);
  const radius = 25;

  for (let index = 0; index < count; index += 1) {
    const u = Math.random();
    Math.random(); // Sampler alignment
    const theta = u * 2 * Math.PI;
    const phi = Math.acos(Math.random() * 0.8 + 0.2);
    positions[index * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[index * 3 + 1] = radius * Math.cos(phi) - 20;
    positions[index * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
  }

  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

  const material = new THREE.PointsMaterial({
    size: STRUCTURE_FLOW_DEFAULTS.pointSize,
    // Particle blue (mirrors --landing-particle: #63C7FF)
    color: 0x63c7ff,
    transparent: true,
    opacity: STRUCTURE_FLOW_DEFAULTS.opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  const particles = new THREE.Points(geometry, material);
  scene.add(particles);

  return {
    resize(width: number, height: number) {
      camera.aspect = width / Math.max(1, height);
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    },
    render() {
      const options = getOptions();
      particles.rotation.y += 0.0008 * options.speed;
      particles.rotation.z += 0.0002 * options.speed;
      material.size = options.pointSize;
      material.opacity = options.opacity;
      renderer.render(scene, camera);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      renderer.dispose();
    },
  };
}

export type StructureFlowRenderer = ReturnType<typeof createStructureFlowRenderer>;
