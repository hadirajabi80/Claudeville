// Everything around the rooms: the ground, the yard in front of the bottom row (with a pond, a picnic table and a
// fire pit where agents spend their breaks), and the name signs over every doorway.
import * as THREE from 'three';
import { C } from './palette';
import { GRID, ROOM_SIZE, BACK_ARCH, YARD, GATE, type RoomTheme, type Spot, type World } from './world';
import type { Grounds } from './colliders';

const std = (color: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...opts });
const hexCss = (n: number) => '#' + n.toString(16).padStart(6, '0');

/** Centre and size of the whole building (all rooms and the yard), in world units. */
export function buildingBounds() {
  const cols = GRID.map(([c]) => c);
  const rows = GRID.map(([, r]) => r);
  const x0 = Math.min(...cols) * ROOM_SIZE - 7;
  const x1 = Math.max(...cols) * ROOM_SIZE + 7;
  const z0 = Math.min(...rows) * ROOM_SIZE - 5;
  const z1 = Math.max(Math.max(...rows) * ROOM_SIZE + 9, YARD.z1);
  return { x0, x1, z0, z1, center: new THREE.Vector3((x0 + x1) / 2, 0, (z0 + z1) / 2) };
}

/** The yard: walkable ground, places to hang out, and its part of the walk graph ("Y:" nodes). */
export interface Yard {
  grounds: Grounds;
  spots: Spot[];
  nodes: [string, number, number][];
  links: [string, string][];
  update(dt: number, g: number): void;
}

export function buildGrounds(scene: THREE.Scene, worlds: World[]): Yard {
  const b = buildingBounds();
  // ground outside, so the open sides do not float in the void
  const ground = new THREE.Mesh(new THREE.CircleGeometry(150, 64), std(0xeadfcd));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(b.center.x, -0.02, b.center.z);
  ground.receiveShadow = true;
  scene.add(ground);
  for (const w of worlds) doorSigns(scene, w, worlds);
  return yard(scene, worlds);
}

function signMesh(theme: RoomTheme, w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = 384;
  c.height = Math.round((384 * h) / w);
  const g = c.getContext('2d')!;
  g.fillStyle = hexCss(theme.accent);
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#fff';
  g.font = `bold ${Math.round(c.height * 0.6)}px Georgia, serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(theme.short, c.width / 2, c.height / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 }));
}

/** Over each doorway: the name of the room behind it, on both sides. */
function doorSigns(scene: THREE.Scene, w: World, worlds: World[]) {
  const o = w.origin;
  if (w.leftRoom >= 0) {
    const into = signMesh(w.theme, 0.9, 0.24); // seen from the left neighbour
    into.position.set(o.x - 7.17, 2.5, o.z + 3.5);
    into.rotation.y = -Math.PI / 2;
    const back = signMesh(worlds[w.leftRoom].theme, 0.9, 0.24); // seen from inside, leading out
    back.position.set(o.x - 6.99, 2.5, o.z + 3.5);
    back.rotation.y = Math.PI / 2;
    scene.add(into, back);
  }
  if (w.backRoom >= 0) {
    const x = o.x + (BACK_ARCH.x0 + BACK_ARCH.x1) / 2;
    const into = signMesh(w.theme, 1.1, 0.28);
    into.position.set(x, 2.6, o.z - 5.17);
    into.rotation.y = Math.PI;
    const back = signMesh(worlds[w.backRoom].theme, 1.1, 0.28);
    back.position.set(x, 2.6, o.z - 4.99);
    scene.add(into, back);
  }
}

/** The yard in front of the bottom row of rooms, reached through a gap in the hedge from each of them. */
function yard(scene: THREE.Scene, worlds: World[]): Yard {
  const root = new THREE.Group();
  scene.add(root);
  const grounds: Grounds = { areas: [], boxes: [], circles: [] };
  const spots: Spot[] = [];
  const nodes: [string, number, number][] = [];
  const links: [string, string][] = [];
  const v = (x: number, z: number) => new THREE.Vector3(x, 0, z);
  const { x0, x1, z0, z1 } = YARD;
  const W = x1 - x0;
  const D = z1 - z0;
  const PATH_Z = z0 + 2.0;

  // lawn
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#A9C48F';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 900; i++) {
    g.fillStyle = i % 3 ? 'rgba(120,160,95,0.35)' : 'rgba(210,230,170,0.35)';
    g.fillRect((i * 97) % 256, (i * 61) % 256, 2, 5);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(W / 3.5, D / 3.5);
  const lawn = new THREE.Mesh(new THREE.PlaneGeometry(W, D), std(0xffffff, { map: tex, roughness: 1 }));
  lawn.rotation.x = -Math.PI / 2;
  lawn.position.set((x0 + x1) / 2, 0.004, (z0 + z1) / 2);
  lawn.receiveShadow = true;
  root.add(lawn);

  // the rooms that open onto the yard, and where their gates are
  const gates = worlds.filter((w) => w.onYard).map((w) => ({ w, x: w.origin.x + (GATE.x0 + GATE.x1) / 2 }));

  // low hedges all round, with a gap in front of each of those rooms
  const hedgeM = std(0x6f9a5e, { roughness: 1, flatShading: true });
  const hedge = (ax: number, az: number, bx: number, bz: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.4, bx - ax), 0.7, Math.max(0.4, bz - az)), hedgeM);
    m.position.set((ax + bx) / 2, 0.35, (az + bz) / 2);
    m.castShadow = m.receiveShadow = true;
    root.add(m);
  };
  let from = x0;
  for (const gt of gates) {
    hedge(from, z0 + 0.25, gt.w.origin.x + GATE.x0, z0 + 0.65);
    from = gt.w.origin.x + GATE.x1;
  }
  hedge(from, z0 + 0.25, x1, z0 + 0.65);
  hedge(x0, z1 - 0.4, x1, z1);
  hedge(x0, z0 + 0.25, x0 + 0.4, z1);
  hedge(x1 - 0.4, z0 + 0.25, x1, z1);
  grounds.areas.push({ x0: x0 + 0.5, x1: x1 - 0.5, z0: z0 + 0.9, z1: z1 - 0.5 });
  for (const gt of gates) {
    const o = gt.w.origin;
    grounds.areas.push({ x0: o.x + GATE.x0, x1: o.x + GATE.x1, z0: o.z + 8.3, z1: z0 + 1.5 });
  }

  // a gravel path along the front, with stepping stones up to each gate
  const gravel = new THREE.Mesh(new THREE.PlaneGeometry(W - 6, 0.95), std(0xd8c8ae, { roughness: 1 }));
  gravel.rotation.x = -Math.PI / 2;
  gravel.position.set((x0 + x1) / 2, 0.008, PATH_Z);
  gravel.receiveShadow = true;
  root.add(gravel);
  const stoneM = std(0xd9d2c5, { roughness: 0.95 });
  const stones = (ax: number, az: number, bx: number, bz: number) => {
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, bz - az) / 0.7));
    for (let i = 0; i <= n; i++) {
      const st = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.28, 0.04, 9), stoneM);
      st.position.set(ax + ((bx - ax) * i) / n + ((i * 37) % 7) * 0.015, 0.02, az + ((bz - az) * i) / n);
      st.rotation.y = i;
      st.receiveShadow = true;
      root.add(st);
    }
  };
  for (const gt of gates) {
    stones(gt.x, z0 + 0.5, gt.x, PATH_Z - 0.6);
    nodes.push([`Y:G${gt.w.index}`, gt.x, PATH_Z]);
    links.push([`${gt.w.index}:GATE_OUT`, `Y:G${gt.w.index}`]);
  }
  // hang-out places along the path; each gets a path node and stones leading to it
  const place = (name: string, x: number, toZ: number) => {
    nodes.push([`Y:${name}`, x, PATH_Z]);
    stones(x, PATH_Z + 0.6, x, toZ);
    return `Y:${name}`;
  };
  const wood = std(C.walnut, { roughness: 0.6 });
  const metal = std(C.charcoal);

  // pond, with two places to stand and look at the fish
  const POND = { x: 6, z: z0 + 6.3, r: 1.5 };
  const pond = new THREE.Mesh(new THREE.CircleGeometry(POND.r, 36), std(0x6fa8c8, { roughness: 0.15, metalness: 0.1 }));
  pond.rotation.x = -Math.PI / 2;
  pond.position.set(POND.x, 0.03, POND.z);
  root.add(pond);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(POND.r + 0.05, 0.12, 6, 36), stoneM);
  rim.rotation.x = -Math.PI / 2;
  rim.position.set(POND.x, 0.05, POND.z);
  rim.castShadow = true;
  root.add(rim);
  for (const [dx, dz] of [
    [-0.4, -0.3],
    [0.5, 0.4],
  ]) {
    const pad = new THREE.Mesh(new THREE.CircleGeometry(0.22, 12), std(0x5f8f4e));
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(POND.x + dx, 0.035, POND.z + dz);
    root.add(pad);
  }
  const fish: THREE.Mesh[] = [];
  for (let i = 0; i < 3; i++) {
    const f = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), std(0xf28c38, { emissive: 0xf28c38, emissiveIntensity: 0.2 }));
    f.scale.set(1.8, 0.5, 0.8);
    f.position.y = 0.025;
    root.add(f);
    fish.push(f);
  }
  grounds.circles.push({ x: POND.x, z: POND.z, r: POND.r + 0.15 });
  const pondNode = place('POND', POND.x, POND.z - POND.r - 0.4);
  for (const dx of [-0.8, 0.8]) spots.push({ kind: 'stand', pos: v(POND.x + dx, POND.z - POND.r - 0.45), yaw: 0, node: pondNode, approach: [], group: 'pond', key: pondNode });

  // a bench beside the pond, facing it
  const bench = (x: number, z: number, yaw: number) => {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = yaw;
    for (let i = 0; i < 3; i++) {
      const slat = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.04, 0.12), wood);
      slat.position.set(0, 0.45, -0.15 + i * 0.15);
      slat.castShadow = true;
      g.add(slat);
    }
    const back = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.3, 0.04), wood);
    back.position.set(0, 0.72, 0.24);
    g.add(back);
    for (const lx of [-0.7, 0.7]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.45, 0.45), metal);
      leg.position.set(lx, 0.225, 0.02);
      g.add(leg);
    }
    root.add(g);
  };
  const BENCH = { x: POND.x + 3.0, z: POND.z };
  bench(BENCH.x, BENCH.z, Math.PI / 2); // seat faces -x, toward the pond
  grounds.boxes.push({ x0: BENCH.x - 0.3, x1: BENCH.x + 0.3, z0: BENCH.z - 0.82, z1: BENCH.z + 0.82 });
  const benchNode = place('BENCH', BENCH.x - 0.6, BENCH.z - 1.1);
  for (const dz of [-0.45, 0.45])
    spots.push({ kind: 'couch', pos: v(BENCH.x - 0.05, BENCH.z + dz), yaw: -Math.PI / 2, node: benchNode, approach: [v(BENCH.x - 0.6, BENCH.z + dz)], group: 'bench', key: benchNode });

  // picnic table
  const PIC = { x: 17.5, z: z0 + 6.0 };
  const pic = new THREE.Group();
  pic.position.set(PIC.x, 0, PIC.z);
  root.add(pic);
  const top = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.05, 0.8), wood);
  top.position.y = 0.74;
  top.castShadow = top.receiveShadow = true;
  pic.add(top);
  for (const dz of [-0.65, 0.65]) {
    const seat = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.05, 0.3), wood);
    seat.position.set(0, 0.44, dz);
    seat.castShadow = true;
    pic.add(seat);
  }
  for (const dx of [-0.7, 0.7]) {
    for (const k of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.85, 0.07), wood);
      leg.position.set(dx, 0.4, 0.42 * k);
      leg.rotation.x = 0.55 * k;
      pic.add(leg);
    }
  }
  const cups = [C.terracotta, C.sky, C.amber];
  cups.forEach((col, i) => {
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.035, 0.1, 10), std(col));
    cup.position.set(-0.5 + i * 0.5, 0.82, (i % 2 ? 0.15 : -0.15));
    pic.add(cup);
  });
  grounds.boxes.push({ x0: PIC.x - 0.95, x1: PIC.x + 0.95, z0: PIC.z - 0.85, z1: PIC.z + 0.85 });
  const picNode = place('PICNIC', PIC.x, PIC.z - 1.4);
  for (const dx of [-0.55, 0.55]) {
    spots.push({ kind: 'couch', pos: v(PIC.x + dx, PIC.z - 0.62), yaw: 0, node: picNode, approach: [v(PIC.x + dx, PIC.z - 1.3)], group: 'picnic', key: picNode });
    spots.push({
      kind: 'couch',
      pos: v(PIC.x + dx, PIC.z + 0.62),
      yaw: Math.PI,
      node: picNode,
      approach: [v(PIC.x - 1.3, PIC.z - 1.3), v(PIC.x - 1.3, PIC.z + 1.3), v(PIC.x + dx, PIC.z + 1.3)],
      group: 'picnic',
      key: picNode,
    });
  }

  // fire pit with two deck chairs
  const FIRE = { x: 24.0, z: z0 + 6.0 };
  const pit = new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.12, 6, 14), stoneM);
  pit.rotation.x = -Math.PI / 2;
  pit.position.set(FIRE.x, 0.1, FIRE.z);
  pit.castShadow = true;
  root.add(pit);
  for (let i = 0; i < 3; i++) {
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.6, 6), std(0x6b4a2f));
    log.rotation.set(Math.PI / 2, 0, (i * Math.PI) / 3);
    log.position.set(FIRE.x, 0.08, FIRE.z);
    root.add(log);
  }
  const flames: THREE.Mesh[] = [];
  for (const [dx, dz, h, col] of [
    [0, 0, 0.55, 0xff8a2a],
    [0.08, 0.05, 0.38, 0xffc94a],
    [-0.07, -0.04, 0.32, 0xff5c2a],
  ] as [number, number, number, number][]) {
    const f = new THREE.Mesh(new THREE.ConeGeometry(0.13, h, 7), new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 1.2, transparent: true, opacity: 0.85 }));
    f.position.set(FIRE.x + dx, 0.12 + h / 2, FIRE.z + dz);
    f.userData.h = h;
    root.add(f);
    flames.push(f);
  }
  const fireLight = new THREE.PointLight(0xff9a4a, 2.2, 5, 2);
  fireLight.position.set(FIRE.x, 0.8, FIRE.z);
  root.add(fireLight);
  grounds.circles.push({ x: FIRE.x, z: FIRE.z, r: 0.6 });
  const deckChair = (x: number, z: number, yaw: number) => {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = yaw; // the sitter faces local +z
    const m = std(0x3fb68b, { roughness: 0.7 });
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.05, 0.55), m);
    seat.position.y = 0.4;
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.7, 0.05), m);
    back.position.set(0, 0.7, -0.3);
    back.rotation.x = -0.3;
    seat.castShadow = back.castShadow = true;
    g.add(seat, back);
    for (const ax of [-0.31, 0.31]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.04, 0.6), m);
      arm.position.set(ax, 0.6, -0.02);
      g.add(arm);
      for (const lz of [-0.25, 0.22]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.6, 0.05), m);
        leg.position.set(ax, 0.3, lz);
        g.add(leg);
      }
    }
    root.add(g);
    grounds.circles.push({ x, z, r: 0.38 });
  };
  const fireNode = place('FIRE', FIRE.x, FIRE.z - 1.2);
  for (const side of [-1, 1]) {
    const x = FIRE.x + side * 1.15;
    const yaw = side < 0 ? Math.PI / 2 : -Math.PI / 2; // face the fire
    deckChair(x, FIRE.z, yaw);
    spots.push({ kind: 'couch', pos: v(x, FIRE.z), yaw, node: fireNode, approach: [v(x, FIRE.z - 1.0)], group: 'fire', key: fireNode });
  }
  spots.push({ kind: 'stand', pos: v(FIRE.x, FIRE.z - 1.0), yaw: 0, node: fireNode, approach: [], group: 'fire', key: fireNode });

  // a lookout under a big tree at the far end
  const LOOK = { x: 31.5, z: z0 + 5.4 };
  const lookNode = place('LOOK', LOOK.x, LOOK.z - 0.5);
  spots.push({ kind: 'stand', pos: v(LOOK.x, LOOK.z), yaw: 0.4, node: lookNode, approach: [], group: 'look', key: lookNode });
  spots.push({ kind: 'stand', pos: v(LOOK.x + 0.8, LOOK.z + 0.2), yaw: -0.3, node: lookNode, approach: [], group: 'look', key: lookNode });

  // trees
  const trunkM = std(0x7a5236);
  const leafM = [std(C.sage, { flatShading: true }), std(0x7d9878, { flatShading: true }), std(0x8fb07a, { flatShading: true })];
  for (const [x, z, s] of [
    [-4.5, z0 + 6.2, 1.1],
    [-1.0, z1 - 1.5, 0.9],
    [2.5, z1 - 1.4, 1.0],
    [11.5, z1 - 1.6, 1.15],
    [13.2, z0 + 5.0, 0.85],
    [21.0, z1 - 1.5, 1.0],
    [27.5, z1 - 1.6, 1.1],
    [32.8, z0 + 7.2, 1.3],
    [33.6, z0 + 3.4, 0.9],
  ]) {
    const t = new THREE.Group();
    t.position.set(x, 0, z);
    t.scale.setScalar(s);
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.17, 1.6, 8), trunkM);
    trunk.position.y = 0.8;
    trunk.castShadow = true;
    t.add(trunk);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + x;
      const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(0.75 - (i % 2) * 0.15, 0), leafM[i % 3]);
      crown.position.set(Math.cos(a) * 0.35, 1.95 + (i % 2) * 0.35, Math.sin(a) * 0.35);
      crown.castShadow = true;
      t.add(crown);
    }
    root.add(t);
    grounds.circles.push({ x, z, r: 0.3 * s });
  }

  // flowers along the back hedge
  const petals = [C.terracotta, C.amber, 0xe58fb0, C.warmWhite, 0x9d8cf0];
  for (let i = 0; i < 90; i++) {
    const x = x0 + 1 + ((i * 0.61803) % 1) * (W - 2);
    const f = new THREE.Mesh(new THREE.IcosahedronGeometry(0.07, 0), std(petals[i % petals.length]));
    f.position.set(x, 0.18 + (i % 3) * 0.05, z1 - 0.75 - ((i * 7) % 3) * 0.12);
    root.add(f);
  }

  // the path nodes, joined west to east
  const pathNodes = nodes.filter(([n]) => n.startsWith('Y:')).sort((a, b) => a[1] - b[1]);
  for (let i = 0; i < pathNodes.length - 1; i++) links.push([pathNodes[i][0], pathNodes[i + 1][0]]);

  return {
    grounds,
    spots,
    nodes,
    links,
    update(dt: number, g: number) {
      flames.forEach((f, i) => {
        const k = 1 + 0.18 * Math.sin(g * (9 + i * 3)) + 0.1 * Math.sin(g * 23 + i);
        f.scale.set(1, k, 1);
        f.position.y = 0.12 + (f.userData.h * k) / 2;
      });
      fireLight.intensity = 2 + 0.5 * Math.sin(g * 11) * Math.sin(g * 7.3);
      fish.forEach((f, i) => {
        const a = g * (0.4 + i * 0.13) + i * 2.1;
        const r = 0.5 + 0.35 * Math.sin(g * 0.3 + i);
        f.position.x = POND.x + Math.cos(a) * r;
        f.position.z = POND.z + Math.sin(a) * r;
        f.rotation.y = -a;
      });
      void dt;
    },
  };
}
