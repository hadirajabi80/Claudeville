// One walk graph for the whole building: every room's own graph (nodes named "<room>:<node>"), joined through the
// side doors and back arches, plus the yard ("Y:<node>"). Agents use it to go anywhere, e.g. out for a break.
import * as THREE from 'three';
import { Nav, YARD, type Spot, type World } from './world';
import type { Yard } from './building';

export class Campus {
  readonly nav = new Nav();
  /** which floor each node stands on: a room index, -1 for the yard, -2 outside */
  private region = new Map<string, number>();

  constructor(
    private worlds: World[],
    yard: Yard,
  ) {
    const n = this.nav;
    worlds.forEach((w, i) => {
      for (const [name, p] of w.nav.nodes) n.add(`${i}:${name}`, p.x, p.z);
      for (const [a, bs] of w.nav.edges) for (const b of bs) if (a < b) n.link(`${i}:${a}`, `${i}:${b}`);
    });
    // doorways: out of the side door into the left neighbour, out of the arch into the room behind
    worlds.forEach((w, i) => {
      if (w.leftRoom >= 0) n.link(`${i}:DOOR_OUT`, `${w.leftRoom}:${worlds[w.leftRoom].hub.east}`);
      if (w.backRoom >= 0) n.link(`${i}:ARCH_OUT`, `${w.backRoom}:${worlds[w.backRoom].hub.front}`);
    });
    for (const [name, x, z] of yard.nodes) n.add(name, x, z);
    for (const [a, b] of yard.links) n.link(a, b);
    for (const [name, p] of n.nodes) this.region.set(name, this.regionOf(p));
  }

  /** The floor a point is on: a room index, -1 for the yard, -2 anywhere else. */
  regionOf(p: THREE.Vector3): number {
    const i = this.worlds.findIndex((w) => w.contains(p));
    if (i >= 0) return i;
    if (p.x >= YARD.x0 && p.x <= YARD.x1 && p.z >= YARD.z0 && p.z <= YARD.z1) return -1;
    return -2;
  }

  /** Nearest node on the same floor (so nobody walks through a wall to reach a node next door). */
  nearest(p: THREE.Vector3) {
    const r = this.regionOf(p);
    return this.nav.nearest(p, (k) => this.region.get(k) === r) || this.nav.nearest(p);
  }

  /** Full walk from a position to a spot (or a node key): graph route, then the spot's approach points. */
  pathTo(from: THREE.Vector3, spot: Spot | null, node?: string): THREE.Vector3[] {
    const target = spot ? spot.key! : node!;
    const pts = this.nav.route(this.nearest(from), target);
    if (spot) pts.push(...spot.approach.map((p) => p.clone()));
    return pts;
  }
}
