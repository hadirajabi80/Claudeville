// Simple 2D (XZ) collision world for the player: boxes for furniture, circles for chairs, plants and agents.
import * as THREE from 'three';
import type { World } from './world';

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

export const ROOM = { x0: -6.8, x1: 6.75, z0: -4.78, z1: 4.75 };

export class Colliders {
  boxes: Box[] = [];
  circles: Circle[] = [];

  constructor(world: World) {
    const box = (cx: number, cz: number, hx: number, hz: number) => this.boxes.push({ x0: cx - hx, x1: cx + hx, z0: cz - hz, z1: cz + hz });
    for (const d of world.desks) {
      box(d.center.x, d.center.z, 0.72, 0.37);
    }
    box(-5.52, 1.6, 0.45, 1.15); // couch incl. arms
    box(-4.45, 1.6, 0.2, 0.47); // low table
    box(world.manager.center.x, world.manager.center.z, 1.12, 0.45); // manager desk
    box(-6.62, -3.2, 0.37, 0.87); // coffee counter
    box(-6.78, -0.6, 0.2, 0.62); // bookshelf
    for (const [x, z, r] of [
      [-6.5, -1.9, 0.26],
      [6.4, -4.4, 0.32],
      [-3.2, 4.3, 0.24],
      [6.4, 3.6, 0.22],
    ])
      this.circles.push({ x, z, r });
  }

  /**
   * Push a circle of radius r at p out of every obstacle (and keep it in the room).
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
          // centre inside the box: push out along the shallowest side
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
      // room bounds; the door gap lets you peek out but not leave
      p.x = THREE.MathUtils.clamp(p.x, ROOM.x0 + r, ROOM.x1 - r);
      p.z = THREE.MathUtils.clamp(p.z, ROOM.z0 + r, ROOM.z1 - r);
    }
    return hitExtra;
  }

  /** Is the straight segment a→b free of furniture? Used to shorten the third-person camera arm. */
  clearDistance(from: THREE.Vector3, to: THREE.Vector3, height: number): number {
    // walls are tall; furniture is short (below ~1.3 m), so only walls block a camera above that
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
    // back and left walls
    const bx = -6.9;
    const bz = -4.9;
    if (to.x < bx && dir.x < 0) t = Math.min(t, (bx - from.x) / dir.x);
    if (to.z < bz && dir.z < 0) t = Math.min(t, (bz - from.z) / dir.z);
    return Math.max(0.12, t) * len;
  }
}
