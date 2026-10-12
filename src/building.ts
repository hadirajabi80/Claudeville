// Everything around the rooms: the ground, the garden in the free cell of the grid, and the name
// signs over every doorway, so you always know which room you are walking into.
import * as THREE from 'three';
import { C } from './palette';
import { cellOrigin, GARDEN_CELL, GRID, ROOM_SIZE, BACK_ARCH, type RoomTheme, type World } from './world';
import type { Grounds } from './colliders';

const std = (color: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...opts });
const hexCss = (n: number) => '#' + n.toString(16).padStart(6, '0');

/** Centre and size of the whole building (all grid cells), in world units. */
export function buildingBounds() {
  const cells = [...GRID, GARDEN_CELL];
  const cols = cells.map(([c]) => c);
  const rows = cells.map(([, r]) => r);
  const x0 = Math.min(...cols) * ROOM_SIZE - 7;
  const x1 = Math.max(...cols) * ROOM_SIZE + 7;
  const z0 = Math.min(...rows) * ROOM_SIZE - 5;
  const z1 = Math.max(...rows) * ROOM_SIZE + 9;
  return { x0, x1, z0, z1, center: new THREE.Vector3((x0 + x1) / 2, 0, (z0 + z1) / 2) };
}

export function buildGrounds(scene: THREE.Scene, worlds: World[]): Grounds {
  const b = buildingBounds();
  // ground outside, so the open sides do not float in the void
  const ground = new THREE.Mesh(new THREE.CircleGeometry(140, 64), std(0xeadfcd));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(b.center.x, -0.02, b.center.z);
  ground.receiveShadow = true;
  scene.add(ground);
  for (const w of worlds) doorSigns(scene, w, worlds);
  return garden(scene, worlds);
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

/** A small walled garden in the free grid cell, reachable from the rooms next to it. */
function garden(scene: THREE.Scene, worlds: World[]): Grounds {
  const [col, row] = GARDEN_CELL;
  const o = cellOrigin(col, row);
  const root = new THREE.Group();
  root.position.copy(o);
  scene.add(root);
  const grounds: Grounds = { areas: [], boxes: [], circles: [] };
  const X = (x: number) => o.x + x;
  const Z = (z: number) => o.z + z;

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
  tex.repeat.set(4, 4);
  const lawn = new THREE.Mesh(new THREE.PlaneGeometry(14, 14), std(0xffffff, { map: tex, roughness: 1 }));
  lawn.rotation.x = -Math.PI / 2;
  lawn.position.set(0, 0.004, 2);
  lawn.receiveShadow = true;
  root.add(lawn);

  // which neighbours open onto the garden: the room behind (through its open front) and the room to the left
  const behind = worlds.findIndex((w) => w.origin.x === o.x && w.origin.z === o.z - ROOM_SIZE);
  const left = worlds.findIndex((w) => w.origin.x === o.x - ROOM_SIZE && w.origin.z === o.z);

  // low hedges all round, with gaps where the rooms open onto the lawn
  const hedgeM = std(0x6f9a5e, { roughness: 1, flatShading: true });
  const hedge = (x0: number, z0: number, x1: number, z1: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.4, x1 - x0), 0.7, Math.max(0.4, z1 - z0)), hedgeM);
    m.position.set((x0 + x1) / 2, 0.35, (z0 + z1) / 2);
    m.castShadow = m.receiveShadow = true;
    root.add(m);
  };
  const run = (axis: 'x' | 'z', at: number, from: number, to: number, gap?: [number, number]) => {
    const parts: [number, number][] = gap ? [[from, gap[0]], [gap[1], to]] : [[from, to]];
    for (const [a, b] of parts) (axis === 'z' ? hedge(a, at - 0.2, b, at + 0.2) : hedge(at - 0.2, a, at + 0.2, b));
  };
  const TOP_GAP: [number, number] = [-1, 1];
  const LEFT_GAP: [number, number] = [1, 3];
  run('z', -4.75, -6.95, 6.8, behind >= 0 ? TOP_GAP : undefined);
  run('x', -6.75, -4.55, 8.8, left >= 0 ? LEFT_GAP : undefined);
  run('z', 8.8, -6.95, 6.8);
  run('x', 6.8, -4.55, 8.6);
  grounds.areas.push({ x0: X(-6.5), x1: X(6.55), z0: Z(-4.5), z1: Z(8.55) });
  if (behind >= 0) grounds.areas.push({ x0: X(TOP_GAP[0]), x1: X(TOP_GAP[1]), z0: Z(-5.8), z1: Z(-4.0) });
  if (left >= 0) grounds.areas.push({ x0: X(-7.8), x1: X(-6.0), z0: Z(LEFT_GAP[0]), z1: Z(LEFT_GAP[1]) });

  // stepping-stone paths from each opening to the pond
  const stoneM = std(0xd9d2c5, { roughness: 0.95 });
  const stones = (ax: number, az: number, bx: number, bz: number) => {
    const n = Math.round(Math.hypot(bx - ax, bz - az) / 0.75);
    for (let i = 0; i <= n; i++) {
      const s = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.3, 0.04, 9), stoneM);
      s.position.set(ax + ((bx - ax) * i) / n + ((i * 37) % 7) * 0.02, 0.02, az + ((bz - az) * i) / n);
      s.rotation.y = i;
      s.receiveShadow = true;
      root.add(s);
    }
  };
  if (behind >= 0) stones(0, -4.3, 0.3, 0.6);
  if (left >= 0) stones(-6.3, 2, -2.6, 2.2);

  // pond with a stone rim
  const pond = new THREE.Mesh(new THREE.CircleGeometry(1.35, 36), std(0x6fa8c8, { roughness: 0.15, metalness: 0.1 }));
  pond.rotation.x = -Math.PI / 2;
  pond.position.set(0.6, 0.03, 2.6);
  root.add(pond);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(1.4, 0.12, 6, 36), stoneM);
  rim.rotation.x = -Math.PI / 2;
  rim.position.set(0.6, 0.05, 2.6);
  rim.castShadow = true;
  root.add(rim);
  for (const [x, z] of [
    [0.2, 2.3],
    [1.0, 3.0],
  ]) {
    const pad = new THREE.Mesh(new THREE.CircleGeometry(0.22, 12), std(0x5f8f4e));
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(x, 0.035, z);
    root.add(pad);
  }
  grounds.circles.push({ x: X(0.6), z: Z(2.6), r: 1.5 });

  // trees
  const trunkM = std(0x7a5236);
  const leafM = [std(C.sage, { flatShading: true }), std(0x7d9878, { flatShading: true }), std(0x8fb07a, { flatShading: true })];
  for (const [x, z, s] of [
    [-4.6, 6.6, 1.1],
    [4.6, 6.8, 1.0],
    [4.8, -2.6, 1.2],
    [-4.8, -2.4, 0.9],
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
    grounds.circles.push({ x: X(x), z: Z(z), r: 0.3 * s });
  }

  // benches facing the pond
  const wood = std(C.walnut, { roughness: 0.6 });
  const metal = std(C.charcoal);
  for (const [x, z, yaw] of [
    [0.6, 5.3, 0],
    [3.6, 2.6, Math.PI / 2],
  ]) {
    const bench = new THREE.Group();
    bench.position.set(x, 0, z);
    bench.rotation.y = yaw;
    for (let i = 0; i < 3; i++) {
      const slat = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.04, 0.12), wood);
      slat.position.set(0, 0.45, -0.15 + i * 0.15);
      slat.castShadow = true;
      bench.add(slat);
    }
    const backrest = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.3, 0.04), wood);
    backrest.position.set(0, 0.72, 0.24);
    bench.add(backrest);
    for (const lx of [-0.7, 0.7]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.45, 0.45), metal);
      leg.position.set(lx, 0.225, 0.02);
      bench.add(leg);
    }
    root.add(bench);
    const hx = yaw ? 0.3 : 0.82;
    const hz = yaw ? 0.82 : 0.3;
    grounds.boxes.push({ x0: X(x - hx), x1: X(x + hx), z0: Z(z - hz), z1: Z(z + hz) });
  }

  // flower beds along the hedges
  const petals = [C.terracotta, C.amber, 0xe58fb0, C.warmWhite, 0x9d8cf0];
  for (let i = 0; i < 46; i++) {
    const side = i % 2;
    const u = ((i * 0.61803) % 1) * 12.6 - 6.3;
    const x = side ? u : 6.3 - ((i * 7) % 3) * 0.15;
    const z = side ? 8.3 - ((i * 5) % 3) * 0.15 : u + 2;
    if (Math.abs(x - 6.3) < 1 && z > 5.8 && z < 7.6) continue;
    const f = new THREE.Mesh(new THREE.IcosahedronGeometry(0.07, 0), std(petals[i % petals.length]));
    f.position.set(x, 0.18 + (i % 3) * 0.05, z);
    root.add(f);
  }
  return grounds;
}
