// Performance helpers: merge static furniture into a few big meshes, and adapt render resolution to the frame rate.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** A stable key for "these two materials look the same", so look-alike furniture shares one draw call. */
function matKey(m: THREE.Material): string | null {
  const s = m as THREE.MeshStandardMaterial;
  if (!(s as any).isMeshStandardMaterial || s.transparent || s.opacity < 1) return null;
  return [
    s.color.getHex(),
    s.roughness.toFixed(2),
    s.metalness.toFixed(2),
    s.emissive.getHex(),
    s.emissiveIntensity.toFixed(2),
    s.map?.uuid ?? '-',
    s.emissiveMap?.uuid ?? '-',
    s.side,
    s.flatShading ? 1 : 0,
  ].join('|');
}

/**
 * Bake every static mesh under `root` (except the excluded subtrees) into one mesh per material look.
 * Typically turns several hundred furniture draw calls into a few dozen.
 */
export function mergeStatic(root: THREE.Object3D, exclude: THREE.Object3D[]): { before: number; after: number } {
  root.updateMatrixWorld(true);
  // bake transforms relative to root, so merging inside a movable group (a chair, a plant) keeps working
  const rootInv = root.matrixWorld.clone().invert();
  const skip = new Set(exclude);
  const groups = new Map<string, { mat: THREE.Material; cast: boolean; receive: boolean; meshes: THREE.Mesh[] }>();
  const isExcluded = (o: THREE.Object3D) => {
    for (let x: THREE.Object3D | null = o; x; x = x.parent) if (skip.has(x)) return true;
    return false;
  };
  let before = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || Array.isArray(m.material) || isExcluded(m)) return;
    const k = matKey(m.material);
    if (!k) return;
    before++;
    const key = `${k}|${m.castShadow ? 1 : 0}${m.receiveShadow ? 1 : 0}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { mat: m.material, cast: m.castShadow, receive: m.receiveShadow, meshes: [] }));
    g.meshes.push(m);
  });
  let after = 0;
  for (const g of groups.values()) {
    if (g.meshes.length < 2) {
      after += g.meshes.length;
      continue;
    }
    const geos = g.meshes.map((m) => {
      const geo = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()).applyMatrix4(rootInv.clone().multiply(m.matrixWorld));
      return geo;
    });
    // keep only attributes every piece has
    const common = Object.keys(geos[0].attributes).filter((n) => geos.every((x) => x.getAttribute(n)));
    for (const geo of geos) for (const n of Object.keys(geo.attributes)) if (!common.includes(n)) geo.deleteAttribute(n);
    for (const geo of geos) geo.morphAttributes = {};
    const merged = mergeGeometries(geos, false);
    geos.forEach((x) => x.dispose());
    if (!merged) {
      after += g.meshes.length;
      continue;
    }
    const mesh = new THREE.Mesh(merged, g.mat);
    mesh.castShadow = g.cast;
    mesh.receiveShadow = g.receive;
    mesh.matrixAutoUpdate = false;
    mesh.name = 'static-merged';
    root.add(mesh);
    for (const m of g.meshes) m.parent?.remove(m);
    after++;
  }
  return { before, after };
}

/** Only parts big enough to matter cast shadows (skips fingers, eyes, cords, badges…). */
export function trimShadowCasters(root: THREE.Object3D, minRadius = 0.07) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.castShadow) return;
    if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
    const s = m.getWorldScale(new THREE.Vector3());
    if (m.geometry.boundingSphere!.radius * Math.max(s.x, s.y, s.z) < minRadius) m.castShadow = false;
  });
}

/** Lowers (and later restores) the render resolution to keep the frame rate smooth. */
export class AdaptiveResolution {
  private frames = 0;
  private acc = 0;
  private level: number;
  private readonly levels: number[];

  constructor(private renderer: THREE.WebGLRenderer) {
    const max = Math.min(devicePixelRatio || 1, 1.5);
    this.levels = [max, Math.min(max, 1.25), 1, 0.85].filter((v, i, a) => a.indexOf(v) === i);
    this.level = 0;
    renderer.setPixelRatio(this.levels[0]);
  }

  /** Call once per rendered frame with the real frame time. */
  tick(dt: number) {
    if (document.hidden || dt > 0.5) return;
    this.frames++;
    this.acc += dt;
    if (this.acc < 2) return;
    const fps = this.frames / this.acc;
    this.frames = 0;
    this.acc = 0;
    if (fps < 42 && this.level < this.levels.length - 1) this.set(this.level + 1);
    else if (fps > 58 && this.level > 0) this.set(this.level - 1);
  }

  private set(l: number) {
    this.level = l;
    this.renderer.setPixelRatio(this.levels[l]);
    this.renderer.setSize(innerWidth, innerHeight, false);
  }
}
