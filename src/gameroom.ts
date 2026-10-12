// The game room: a couch in front of a big TV with a console, a foosball table, a ping-pong table and two
// arcade cabinets. Agents on a break come here to play; the tables and screens come alive while they do.
import * as THREE from 'three';
import { C } from './palette';
import { box, cyl, std, canvasTex, type Nav, type Spot, type World } from './world';
import { PONG_PERIOD } from './pose';

export interface GameRoom {
  /** moving parts, never merged into static geometry */
  dynamic: THREE.Object3D[];
  /** how many agents are playing at each game right now (set by the office every frame) */
  players: Map<string, number>;
  graph(n: Nav): void;
  update(dt: number, g: number, live: boolean): void;
}

const TV = { x: -1.5, w: 2.8, h: 1.58 };
const COUCH = { x: -1.5, z: -1.6 };
const FOOS = { x: 3.0, z: 1.2 };
const PONG = { x: 3.0, z: -2.6 };
const ARCADES = [5.7, 7.1];

export function buildGameRoom(w: World): GameRoom {
  const s = w.root;
  const players = new Map<string, number>();
  const dynamic: THREE.Object3D[] = [];
  const spots = (sp: Spot) => w.lounge.push(sp);
  const v = (x: number, z: number) => new THREE.Vector3(x, 0, z);
  const accent = w.theme.accent;

  // ------------------------------------------------------------ wall sign and emblem
  const logo = new THREE.Group();
  logo.position.set(-4.6, 2.3, -4.96);
  w.emblem(logo, std(accent, { emissive: accent, emissiveIntensity: 0.35, roughness: 0.5 }));
  s.add(logo);
  w.logo = logo;
  const { tex: signTex } = canvasTex(512, 96, (g) => {
    g.fillStyle = '#2B2B2E';
    g.font = 'bold 54px Georgia, serif';
    g.textAlign = 'center';
    g.fillText(w.theme.name, 256, 66);
  });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.36), new THREE.MeshStandardMaterial({ map: signTex, transparent: true, roughness: 0.8 }));
  sign.position.set(-4.6, 1.62, -4.97);
  s.add(sign);
  // party lights along the top of the back wall
  const bulbColors = [0xff5c7a, 0xffc94a, 0x5ce1a6, 0x5cb8ff, 0xc77dff];
  for (let i = 0; i < 26; i++) {
    const x = -6.6 + i * 0.47;
    const b = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), new THREE.MeshStandardMaterial({ color: bulbColors[i % 5], emissive: bulbColors[i % 5], emissiveIntensity: 0.9 }));
    b.position.set(x, 2.82 - 0.08 * Math.sin((i % 4) * (Math.PI / 3)), -4.9);
    s.add(b);
  }

  // ------------------------------------------------------------ TV corner
  const { tex: rugTex } = canvasTex(256, 256, (g) => {
    g.fillStyle = '#3B2F5C';
    g.fillRect(0, 0, 256, 256);
    g.strokeStyle = '#E0457B';
    g.lineWidth = 6;
    g.strokeRect(12, 12, 232, 232);
    g.fillStyle = 'rgba(255,255,255,0.12)';
    for (let i = 0; i < 6; i++) for (let k = 0; k < 6; k++) if ((i + k) % 2) g.fillRect(28 + i * 34, 28 + k * 34, 34, 34);
  });
  const rug = new THREE.Mesh(new THREE.PlaneGeometry(5.2, 3.6), std(0xffffff, { map: rugTex, roughness: 1 }));
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(TV.x, 0.012, -2.6);
  rug.receiveShadow = true;
  s.add(rug);
  // low cabinet with the console on it, the TV on the wall above
  box(2.6, 0.42, 0.45, std(0x2b2b2e, { roughness: 0.5 }), TV.x, 0.21, -4.62, s);
  w.blockers.boxes.push([TV.x, -4.62, 1.3, 0.28]);
  box(0.42, 0.09, 0.3, std(0xf3f3f3, { roughness: 0.3 }), TV.x - 0.6, 0.47, -4.6, s);
  box(0.3, 0.01, 0.01, std(0x4aa3ff, { emissive: 0x4aa3ff, emissiveIntensity: 1 }), TV.x - 0.6, 0.47, -4.44, s, false);
  box(0.5, 0.28, 0.2, std(0x1b1b1e), TV.x + 0.7, 0.56, -4.62, s); // speaker
  box(TV.w + 0.1, TV.h + 0.1, 0.06, std(0x18181b, { roughness: 0.3 }), TV.x, 1.6, -4.93, s, false);
  const tvScreen = canvasTex(320, 180, () => {});
  const tv = new THREE.Mesh(
    new THREE.PlaneGeometry(TV.w, TV.h),
    new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveMap: tvScreen.tex, emissiveIntensity: 0.95, roughness: 0.3 }),
  );
  tv.position.set(TV.x, 1.6, -4.89);
  s.add(tv);

  // couch facing the TV (built facing +x, turned to face -z)
  const fabric = std(0x5b4b8a, { roughness: 0.95 });
  const cushion = std(0x6d5ca3, { roughness: 1 });
  const couch = new THREE.Group();
  couch.position.set(COUCH.x, 0, COUCH.z);
  couch.rotation.y = Math.PI / 2;
  s.add(couch);
  box(0.7, 0.3, 2.0, fabric, 0, 0.22, 0, couch);
  for (const z of [-0.65, 0, 0.65]) box(0.62, 0.12, 0.62, cushion, 0.03, 0.42, z, couch);
  box(0.2, 0.62, 2.0, fabric, -0.3, 0.6, 0, couch);
  for (const z of [-1.05, 1.05]) {
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.12, 0.5, 6, 12), fabric);
    arm.rotation.z = Math.PI / 2;
    arm.position.set(0, 0.5, z);
    arm.castShadow = true;
    couch.add(arm);
  }
  w.blockers.boxes.push([COUCH.x, COUCH.z + 0.05, 1.15, 0.45]);
  for (const dx of [-0.62, 0, 0.62]) {
    const x = COUCH.x + dx;
    spots({ kind: 'game', pos: v(x, COUCH.z - 0.12), yaw: Math.PI, node: 'TV_W', approach: [v(x, COUCH.z - 0.75)], group: 'tv' });
  }
  // bean bags either side
  for (const [x, col] of [
    [-3.75, 0xe0457b],
    [0.75, 0x3fb68b],
  ]) {
    const bag = new THREE.Mesh(new THREE.SphereGeometry(0.45, 16, 12), std(col, { roughness: 1 }));
    bag.scale.set(1, 0.6, 1);
    bag.position.set(x, 0.26, -1.75);
    bag.castShadow = bag.receiveShadow = true;
    s.add(bag);
    w.blockers.circles.push([x, -1.75, 0.42]);
    spots({ kind: 'game', pos: v(x, -1.85), yaw: Math.PI, node: 'TV_W', approach: [v(x, -2.55)], group: 'tv' });
  }

  // ------------------------------------------------------------ foosball
  const foos = new THREE.Group();
  foos.position.set(FOOS.x, 0, FOOS.z);
  s.add(foos);
  const darkWood = std(0x4a3022, { roughness: 0.6 });
  for (const [x, z] of [
    [-0.56, -0.3],
    [0.56, -0.3],
    [-0.56, 0.3],
    [0.56, 0.3],
  ])
    box(0.07, 0.62, 0.07, darkWood, x, 0.31, z, foos);
  box(1.22, 0.03, 0.68, std(0x3f9a4f, { roughness: 0.9 }), 0, 0.68, 0, foos);
  box(1.3, 0.24, 0.05, darkWood, 0, 0.74, -0.36, foos);
  box(1.3, 0.24, 0.05, darkWood, 0, 0.74, 0.36, foos);
  box(0.05, 0.24, 0.72, darkWood, -0.63, 0.74, 0, foos);
  box(0.05, 0.24, 0.72, darkWood, 0.63, 0.74, 0, foos);
  box(0.02, 0.1, 0.22, std(0x18181b), -0.6, 0.74, 0, foos, false);
  box(0.02, 0.1, 0.22, std(0x18181b), 0.6, 0.74, 0, foos, false);
  w.blockers.boxes.push([FOOS.x, FOOS.z, 0.7, 0.42]);
  const rodM = std(0xc9ccd2, { metalness: 0.7, roughness: 0.3 });
  const red = std(0xd94a4a);
  const blue = std(0x3b6cf6);
  const rods: THREE.Group[] = [];
  const counts = [1, 2, 3, 3, 3, 3, 2, 1];
  const team = [0, 0, 1, 0, 1, 0, 1, 1]; // red handles on +z, blue on -z
  counts.forEach((n, i) => {
    const rod = new THREE.Group();
    rod.position.set(-0.525 + i * 0.15, 0.82, 0);
    foos.add(rod);
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 1.25, 6), rodM);
    bar.rotation.x = Math.PI / 2;
    rod.add(bar);
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.14, 8), std(0x18181b));
    handle.rotation.x = Math.PI / 2;
    handle.position.z = team[i] ? -0.6 : 0.6;
    rod.add(handle);
    for (let k = 0; k < n; k++) {
      const man = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.13, 0.04), team[i] ? blue : red);
      man.position.set(0, -0.05, n === 1 ? 0 : -0.24 + (k * 0.48) / (n - 1));
      rod.add(man);
    }
    rods.push(rod);
    dynamic.push(rod);
  });
  const foosBall = new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 8), std(0xfaf7f2));
  foosBall.position.set(0, 0.72, 0);
  foos.add(foosBall);
  dynamic.push(foosBall);
  for (const x of [-0.35, 0.35]) {
    spots({ kind: 'play', pos: v(FOOS.x + x, FOOS.z - 0.85), yaw: 0, node: 'FOOS', approach: [v(FOOS.x - 1.05, FOOS.z + 1.4), v(FOOS.x - 1.05, FOOS.z - 0.85)], group: 'foos' });
    spots({ kind: 'play', pos: v(FOOS.x + x, FOOS.z + 0.85), yaw: Math.PI, node: 'FOOS', approach: [], group: 'foos' });
  }

  // ------------------------------------------------------------ ping-pong
  const pong = new THREE.Group();
  pong.position.set(PONG.x, 0, PONG.z);
  s.add(pong);
  box(2.2, 0.04, 1.2, std(0x2e6f9e, { roughness: 0.5 }), 0, 0.74, 0, pong);
  box(2.2, 0.005, 0.02, std(0xfaf7f2), 0, 0.762, 0, pong, false);
  for (const z of [-0.59, 0.59]) box(2.2, 0.005, 0.02, std(0xfaf7f2), 0, 0.762, z, pong, false);
  for (const x of [-1.09, 1.09]) box(0.02, 0.005, 1.2, std(0xfaf7f2), x, 0.762, 0, pong, false);
  const net = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.13, 1.32), new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.75 }));
  net.position.set(0, 0.825, 0);
  pong.add(net);
  for (const [x, z] of [
    [-0.9, -0.5],
    [0.9, -0.5],
    [-0.9, 0.5],
    [0.9, 0.5],
  ])
    cyl(0.03, 0.03, 0.72, std(C.charcoal), x, 0.36, z, pong, 8);
  w.blockers.boxes.push([PONG.x, PONG.z, 1.12, 0.62]);
  const pongBall = new THREE.Mesh(new THREE.SphereGeometry(0.025, 10, 8), std(0xffa646, { emissive: 0xffa646, emissiveIntensity: 0.3 }));
  pongBall.visible = false;
  s.add(pongBall);
  dynamic.push(pongBall);
  spots({ kind: 'pong', pos: v(PONG.x - 1.6, PONG.z), yaw: Math.PI / 2, node: 'PONG', approach: [v(PONG.x - 1.6, -0.8)], group: 'pong' });
  spots({ kind: 'pong', pos: v(PONG.x + 1.6, PONG.z), yaw: -Math.PI / 2, node: 'PONG', approach: [v(PONG.x + 1.6, -0.8)], group: 'pong' });

  // ------------------------------------------------------------ arcade cabinets on the left wall
  const arcadeScreens: { tex: THREE.CanvasTexture; g: CanvasRenderingContext2D; group: string; hue: number }[] = [];
  ARCADES.forEach((z, i) => {
    const cab = new THREE.Group();
    cab.position.set(-6.55, 0, z);
    cab.rotation.y = Math.PI / 2; // screen faces +x, into the room
    s.add(cab);
    const body = std(i ? 0x2b3a8a : 0x8a2b4f, { roughness: 0.6 });
    box(0.66, 1.0, 0.6, body, 0, 0.5, 0, cab);
    box(0.66, 0.9, 0.36, body, 0, 1.45, -0.12, cab);
    box(0.7, 0.08, 0.3, std(0x18181b), 0, 1.03, 0.18, cab); // control panel
    const stick = cyl(0.012, 0.012, 0.09, std(0x18181b), -0.12, 1.11, 0.2, cab, 6);
    stick.castShadow = false;
    for (const [bx, col] of [
      [0.06, 0xff5c7a],
      [0.16, 0xffc94a],
    ] as [number, number][]) cyl(0.03, 0.03, 0.02, std(col, { emissive: col, emissiveIntensity: 0.4 }), bx, 1.08, 0.2, cab, 10);
    const scr = canvasTex(96, 128, () => {});
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5), new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveMap: scr.tex, emissiveIntensity: 1 }));
    screen.position.set(0, 1.45, 0.065);
    screen.rotation.x = -0.12;
    cab.add(screen);
    const marquee = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.16, 0.04), std(0xffd27a, { emissive: 0xffc94a, emissiveIntensity: 0.8 }));
    marquee.position.set(0, 1.84, 0.07);
    cab.add(marquee);
    w.blockers.boxes.push([-6.55, z, 0.34, 0.36]);
    const group = `arcade${i}`;
    arcadeScreens.push({ ...scr, group, hue: i ? 200 : 330 });
    spots({ kind: 'play', pos: v(-5.72, z), yaw: -Math.PI / 2, node: 'W', approach: [], group });
  });

  // ------------------------------------------------------------ screens
  let tvAcc = 1;
  let arcadeAcc = 1;
  let tvIdle = false;
  const drawTv = (g: number, playing: boolean) => {
    const c = tvScreen.g;
    if (!playing) {
      // menu screen, redrawn only when it changes
      const blink = Math.floor(g * 1.5) % 2 === 0;
      c.fillStyle = '#1B1440';
      c.fillRect(0, 0, 320, 180);
      c.fillStyle = '#E0457B';
      c.font = 'bold 30px Georgia, serif';
      c.textAlign = 'center';
      c.fillText('AGENT CUP 26', 160, 78);
      if (blink) {
        c.fillStyle = '#F3EDE3';
        c.font = 'bold 16px ui-monospace, Consolas, monospace';
        c.fillText('PRESS START', 160, 120);
      }
      c.textAlign = 'left';
      tvScreen.tex.needsUpdate = true;
      return;
    }
    // a top-down football match
    c.fillStyle = '#3F9A4F';
    c.fillRect(0, 0, 320, 180);
    c.fillStyle = 'rgba(255,255,255,0.08)';
    for (let i = 0; i < 8; i += 2) c.fillRect(i * 40, 0, 40, 180);
    c.strokeStyle = 'rgba(255,255,255,0.85)';
    c.lineWidth = 2;
    c.strokeRect(10, 10, 300, 160);
    c.beginPath();
    c.moveTo(160, 10);
    c.lineTo(160, 170);
    c.stroke();
    c.beginPath();
    c.arc(160, 90, 22, 0, Math.PI * 2);
    c.stroke();
    c.strokeRect(10, 55, 30, 70);
    c.strokeRect(280, 55, 30, 70);
    const bx = 160 + 120 * Math.sin(g * 0.9) * Math.cos(g * 0.37);
    const by = 90 + 60 * Math.sin(g * 1.3 + 1);
    for (let k = 0; k < 10; k++) {
      const home = k < 5;
      const px = (home ? 60 : 260) + (bx - 160) * 0.55 + 40 * Math.sin(k * 2.1 + g * (0.8 + k * 0.05));
      const py = 25 + (k % 5) * 32 + 12 * Math.sin(g * 1.1 + k) + (by - 90) * 0.25;
      c.fillStyle = home ? '#D94A4A' : '#3B6CF6';
      c.beginPath();
      c.arc(px, py, 5, 0, Math.PI * 2);
      c.fill();
    }
    c.fillStyle = '#fff';
    c.beginPath();
    c.arc(bx, by, 3, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = 'rgba(0,0,0,0.55)';
    c.fillRect(118, 0, 84, 18);
    c.fillStyle = '#fff';
    c.font = 'bold 13px ui-monospace, Consolas, monospace';
    const goals = Math.floor(g / 23);
    c.fillText(`${goals % 4} - ${(goals * 3) % 5}`, 141, 13);
    tvScreen.tex.needsUpdate = true;
  };
  const drawArcade = (a: (typeof arcadeScreens)[number], g: number, playing: boolean) => {
    const c = a.g;
    c.fillStyle = '#05060f';
    c.fillRect(0, 0, 96, 128);
    if (!playing) {
      c.fillStyle = `hsl(${(a.hue + g * 40) % 360},90%,60%)`;
      c.font = 'bold 13px ui-monospace, Consolas, monospace';
      c.textAlign = 'center';
      c.fillText('INSERT', 48, 56);
      c.fillText('COIN', 48, 74);
      c.textAlign = 'left';
    } else {
      // space invaders, more or less
      const off = Math.sin(g * 1.5) * 10;
      c.fillStyle = `hsl(${a.hue},90%,65%)`;
      for (let r = 0; r < 4; r++) for (let k = 0; k < 5; k++) if ((r * 5 + k + Math.floor(g / 3)) % 7) c.fillRect(14 + k * 15 + off, 14 + r * 13, 9, 7);
      const sx = 48 + 30 * Math.sin(g * 2.3);
      c.fillStyle = '#5CE1A6';
      c.fillRect(sx - 7, 112, 14, 6);
      c.fillStyle = '#fff';
      const shot = (g * 3) % 1;
      c.fillRect(sx - 1, 108 - shot * 90, 2, 6);
    }
    a.tex.needsUpdate = true;
  };
  drawTv(0, false);
  arcadeScreens.forEach((a) => drawArcade(a, 0, false));

  return {
    dynamic,
    players,
    graph(n: Nav) {
      n.add('W', -4.6, 3.2);
      n.add('C', 0.0, 3.2);
      n.add('TV_W', -4.6, -3.0);
      n.add('COFFEE', -5.3, -3.5);
      n.add('FOOS', FOOS.x, 3.2);
      n.add('PONG', PONG.x, -0.8);
      n.add('TABLE', -1.0, 5.85);
      n.link('DOOR_IN', 'W');
      n.link('W', 'C');
      n.link('W', 'TV_W');
      n.link('TV_W', 'COFFEE');
      n.link('C', 'FOOS');
      n.link('C', 'PONG');
      n.link('C', 'TABLE');
    },
    update(dt: number, g: number, live: boolean) {
      const n = (k: string) => players.get(k) ?? 0;
      // foosball: rods twist in bursts and the ball rattles about
      const foosOn = n('foos') > 0;
      rods.forEach((r, i) => {
        const want = foosOn ? 0.9 * Math.sin(g * (5 + i * 0.7) + i) * Math.max(0, Math.sin(g * 1.7 + i * 0.4)) : 0;
        r.rotation.z += (want - r.rotation.z) * Math.min(1, dt * 10);
        r.position.z = foosOn ? 0.05 * Math.sin(g * 3 + i * 1.3) : 0;
      });
      foosBall.position.x = foosOn ? 0.5 * Math.sin(g * 1.9) * Math.cos(g * 0.7) : 0;
      foosBall.position.z = foosOn ? 0.22 * Math.sin(g * 2.7 + 1) : 0;
      // ping-pong: a rally needs two players; the swings in the pose use the same clock
      pongBall.visible = n('pong') >= 2;
      if (pongBall.visible) {
        const ph = ((g % PONG_PERIOD) + PONG_PERIOD) % PONG_PERIOD;
        const half = PONG_PERIOD / 2;
        const east = ph < half;
        const u = (east ? ph : ph - half) / half;
        const x0 = PONG.x - 1.45;
        const x1 = PONG.x + 1.45;
        const x = east ? x0 + (x1 - x0) * u : x1 + (x0 - x1) * u;
        let y: number;
        if (u < 0.6) {
          const k = u / 0.6;
          y = 0.95 + (0.785 - 0.95) * k + 0.22 * Math.sin(Math.PI * k);
        } else {
          const k = (u - 0.6) / 0.4;
          y = 0.785 + (0.95 - 0.785) * k + 0.15 * Math.sin(Math.PI * k);
        }
        pongBall.position.set(x, y, PONG.z + 0.25 * Math.sin(g * 0.9));
      }
      if (!live) return;
      tvAcc += dt;
      const tvOn = n('tv') > 0;
      if (tvOn && tvAcc > 1 / 15) {
        tvAcc = 0;
        tvIdle = false;
        drawTv(g, true);
      } else if (!tvOn && (tvAcc > 0.33 || !tvIdle)) {
        tvAcc = 0;
        tvIdle = true;
        drawTv(g, false);
      }
      arcadeAcc += dt;
      if (arcadeAcc > 1 / 10) {
        arcadeAcc = 0;
        arcadeScreens.forEach((a) => drawArcade(a, g, n(a.group) > 0));
      }
    },
  };
}
