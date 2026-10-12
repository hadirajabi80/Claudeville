// Simple 2D (XZ) collision world for the player: boxes for furniture, circles for plants, chairs and agents,
// and a set of walkable areas (every room's floor, the doorways between neighbouring rooms, and the garden).
import * as THREE from 'three';
import { BACK_ARCH, type World } from './world';

export interface Box {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}
export interface Circle {
  x: number;
  z: number;
  r: number;
}
/** A straight wall the third-person camera may not look through, with doorways in it. */
interface Wall {
  axis: 'x' | 'z'; // the wall is the line x = at (or z = at)
  at: number;
  from: number;
  to: number;
  gaps: [number, number][];
}
/** Extra walkable ground outside the rooms (the yard). */
export interface Grounds {
  areas: Box[];
  boxes: Box[];
  circles: Circle[];
}

export class Colliders {
  boxes: Box[] = [];
  circles: Circle[] = [];
  /** floors you can stand on: one per room (same order as the rooms), then doorways and the yard */
  areas: Box[] = [];
  private rooms: number;
  private walls: Wall[] = [];

  constructor(worlds: World[], grounds?: Grounds) {
    const box = (cx: number, cz: number, hx: number, hz: number) => this.boxes.push({ x0: cx - hx, x1: cx + hx, z0: cz - hz, z1: cz + hz });
    for (const w of worlds) {
      const ox = w.origin.x;
      const oz = w.origin.z;
      for (const [cx, cz, hx, hz] of w.blockers.boxes) box(ox + cx, oz + cz, hx, hz);
      for (const [x, z, r] of w.blockers.circles) this.circles.push({ x: ox + x, z: oz + z, r });
      this.areas.push({ x0: ox - 6.8, x1: ox + 6.75, z0: oz - 4.78, z1: oz + 8.75 });
      // walls the camera stays inside: the back wall and the left wall, with their doorways
      this.walls.push({ axis: 'z', at: oz - 5.08, from: ox - 7.2, to: ox + 7, gaps: w.backRoom >= 0 ? [[ox + BACK_ARCH.x0, ox + BACK_ARCH.x1]] : [] });
      this.walls.push({ axis: 'x', at: ox - 7.08, from: oz - 5.2, to: oz + 9, gaps: w.leftRoom >= 0 ? [[oz + 3, oz + 4]] : [] });
    }
    this.rooms = this.areas.length;
    // doorways: each overlaps both floors by more than a body width, so you can walk through
    for (const w of worlds) {
      const ox = w.origin.x;
      const oz = w.origin.z;
      if (w.leftRoom >= 0) this.areas.push({ x0: ox - 7.9, x1: ox - 6.2, z0: oz + 3.0, z1: oz + 4.0 });
      if (w.backRoom >= 0) this.areas.push({ x0: ox + BACK_ARCH.x0 + 0.05, x1: ox + BACK_ARCH.x1 - 0.05, z0: oz - 5.8, z1: oz - 4.2 });
    }
    if (grounds) {
      this.areas.push(...grounds.areas);
      this.boxes.push(...grounds.boxes);
      this.circles.push(...grounds.circles);
    }
  }

  /** Which room's floor (index) is this point on, or -1 for a doorway or the yard. */
  roomAt(p: THREE.Vector3): number {
    for (let i = 0; i < this.rooms; i++) {
      const a = this.areas[i];
      if (p.x >= a.x0 && p.x <= a.x1 && p.z >= a.z0 && p.z <= a.z1) return i;
    }
    return -1;
  }

  /** Keep a circle of radius r inside the walkable floors. */
  private clampToFloor(p: THREE.Vector3, r: number) {
    let best: { x: number; z: number; d: number } | null = null;
    for (const a of this.areas) {
      const x = THREE.MathUtils.clamp(p.x, a.x0 + r, a.x1 - r);
      const z = THREE.MathUtils.clamp(p.z, a.z0 + r, a.z1 - r);
      const d = (x - p.x) ** 2 + (z - p.z) ** 2;
      if (d < 1e-9) return; // already inside this floor
      if (!best || d < best.d) best = { x, z, d };
    }
    if (best) {
      p.x = best.x;
      p.z = best.z;
    }
  }

  /**
   * Push a circle of radius r at p out of every obstacle (and keep it on the floors).
   * `extra` are dynamic circles such as agents. Returns the index of an extra circle that was hit, or -1.
   */
  resolve(p: THREE.Vector3, r: number, extra: Circle[] = []): number {
    let hitExtra = -1;
    for (let pass = 0; pass < 3; pass++) {
      for (const b of this.boxes) {
        const cx = THREE.MathUtils.clamp(p.x, b.x0, b.x1);
        const cz = THREE.MathUtils.clamp(p.z, b.z0, b.z1);
        let dx = p.x - cx;
        let dz = p.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r * r) continue;
        if (d2 < 1e-8) {
          const opts = [p.x - b.x0, b.x1 - p.x, p.z - b.z0, b.z1 - p.z];
          const m = Math.min(...opts);
          if (m === opts[0]) p.x = b.x0 - r;
          else if (m === opts[1]) p.x = b.x1 + r;
          else if (m === opts[2]) p.z = b.z0 - r;
          else p.z = b.z1 + r;
          continue;
        }
        const d = Math.sqrt(d2);
        dx /= d;
        dz /= d;
        p.x = cx + dx * r;
        p.z = cz + dz * r;
      }
      const all = [...this.circles, ...extra];
      all.forEach((c, i) => {
        const dx = p.x - c.x;
        const dz = p.z - c.z;
        const min = r + c.r;
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min) return;
        const d = Math.sqrt(d2) || 1e-4;
        p.x = c.x + (dx / d) * min;
        p.z = c.z + (dz / d) * min;
        if (i >= this.circles.length) hitExtra = i - this.circles.length;
      });
      this.clampToFloor(p, r);
    }
    return hitExtra;
  }

  /** How far the third-person camera arm can reach from `from` toward `to` before a wall or furniture. */
  clearDistance(from: THREE.Vector3, to: THREE.Vector3, height: number): number {
    const dir = to.clone().sub(from);
    const len = dir.length();
    let t = 1;
    if (height < 1.3) {
      for (let s = 0.1; s <= 1; s += 0.05) {
        const q = from.clone().addScaledVector(dir, s);
        if (this.boxes.some((b) => q.x > b.x0 && q.x < b.x1 && q.z > b.z0 && q.z < b.z1)) {
          t = Math.max(0.15, s - 0.08);
          break;
        }
      }
    }
    // walls (but not their doorways)
    for (const w of this.walls) {
      const a = w.axis === 'x' ? from.x : from.z;
      const b = w.axis === 'x' ? to.x : to.z;
      if ((a - w.at) * (b - w.at) >= 0) continue;
      const s = (w.at - a) / (b - a);
      const along = w.axis === 'x' ? from.z + dir.z * s : from.x + dir.x * s;
      if (along < w.from || along > w.to || w.gaps.some(([g0, g1]) => along > g0 && along < g1)) continue;
      t = Math.min(t, s - 0.1 / len);
    }
    return Math.max(0.12, t) * len;
  }
}
