// The office: room, lights, furniture, desks with live monitors, lounge, door and the walk graph.
import * as THREE from 'three';
import { C } from './palette';
import { Screen, drawSparkle } from './screen';
import { sparkleShape } from './character';
import { APP_NAME } from './brand';

export interface Spot {
  pos: THREE.Vector3; // where the character's root stands/sits
  yaw: number; // facing
  approach: THREE.Vector3[]; // points walked after the graph node, before arriving
  node: string; // graph node this spot hangs off
  kind: 'desk' | 'couch' | 'stand' | 'board' | 'visit';
  occupant?: string;
}

export interface Desk extends Spot {
  index: number;
  side: THREE.Vector3; // point beside the chair where the sit transition starts
  center: THREE.Vector3;
  screen: Screen;
  glow: THREE.Mesh;
  chair: THREE.Object3D;
  chairHome: THREE.Vector3;
  monitor: THREE.Object3D;
  mug: THREE.Mesh;
  steamAt: THREE.Vector3;
  lastSession?: string;
}

const AISLE_Z = -0.75;
const DESK_X = [-2.5, 0, 2.5, 5.0];

function std(color: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, ...opts });
}

function box(w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D, cast = true, receive = true) {
  const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  o.position.set(x, y, z);
  o.castShadow = cast;
  o.receiveShadow = receive;
  parent.add(o);
  return o;
}

function cyl(rt: number, rb: number, h: number, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D, seg = 16) {
  const o = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m);
  o.position.set(x, y, z);
  o.castShadow = true;
  o.receiveShadow = true;
  parent.add(o);
  return o;
}

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  draw(g);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return { tex: t, g, canvas: c };
}

// ------------------------------------------------------------------------------------ nav graph

export class Nav {
  nodes = new Map<string, THREE.Vector3>();
  edges = new Map<string, Set<string>>();

  add(name: string, x: number, z: number) {
    this.nodes.set(name, new THREE.Vector3(x, 0, z));
    this.edges.set(name, new Set());
  }
  link(a: string, b: string) {
    this.edges.get(a)!.add(b);
    this.edges.get(b)!.add(a);
  }
  nearest(p: THREE.Vector3) {
    let best = '';
    let bd = Infinity;
    for (const [k, v] of this.nodes) {
      const d = (v.x - p.x) ** 2 + (v.z - p.z) ** 2;
      if (d < bd) {
        bd = d;
        best = k;
      }
    }
    return best;
  }
  /** Dijkstra over the hand-placed graph; returns node positions from `from` to `to`. */
  route(from: string, to: string): THREE.Vector3[] {
    const dist = new Map<string, number>([[from, 0]]);
    const prev = new Map<string, string>();
    const open = new Set([from]);
    while (open.size) {
      let cur = '';
      let cd = Infinity;
      for (const n of open) if ((dist.get(n) ?? Infinity) < cd) (cd = dist.get(n)!), (cur = n);
      open.delete(cur);
      if (cur === to) break;
      for (const nb of this.edges.get(cur)!) {
        const nd = cd + this.nodes.get(cur)!.distanceTo(this.nodes.get(nb)!);
        if (nd < (dist.get(nb) ?? Infinity)) {
          dist.set(nb, nd);
          prev.set(nb, cur);
          open.add(nb);
        }
      }
    }
    const path: THREE.Vector3[] = [];
    let n: string | undefined = to;
    while (n) {
      path.unshift(this.nodes.get(n)!.clone());
      if (n === from) break;
      n = prev.get(n);
    }
    return path;
  }
}

// ------------------------------------------------------------------------------------ world

export class World {
  readonly desks: Desk[] = [];
  readonly lounge: Spot[] = [];
  readonly boards: Spot[] = [];
  readonly nav = new Nav();
  readonly doorOut = new THREE.Vector3(-7.9, 0, 3.5);
  readonly doorIn = new THREE.Vector3(-6.3, 0, 3.5);
  readonly coffeeSteam = new THREE.Vector3(-6.6, 1.38, -3.2);

  private door!: THREE.Object3D;
  private doorAngle = 0;
  private logo!: THREE.Object3D;
  private plants: THREE.Object3D[] = [];
  private clock!: { tex: THREE.CanvasTexture; g: CanvasRenderingContext2D };
  private board!: { tex: THREE.CanvasTexture; g: CanvasRenderingContext2D };
  private windowTex!: { tex: THREE.CanvasTexture; g: CanvasRenderingContext2D };
  private sun!: THREE.DirectionalLight;
  private hemi!: THREE.HemisphereLight;
  private lastSecond = -1;
  /** The manager's desk at the front of the room, where you sit and dispatch tasks. */
  manager!: {
    center: THREE.Vector3;
    seat: THREE.Vector3;
    seatYaw: number;
    chair: THREE.Object3D;
    bell: THREE.Object3D;
    screen: { tex: THREE.CanvasTexture; g: CanvasRenderingContext2D };
    visitors: Spot[];
  };
  private bellT = -1;

  constructor(private scene: THREE.Scene) {
    this.lights();
    this.room();
    this.buildDesks();
    this.buildLounge();
    this.decor();
    this.buildManager();
    this.graph();
  }

  private lights() {
    this.hemi = new THREE.HemisphereLight(0xfff4e6, 0xc9b79c, 0.75);
    this.scene.add(this.hemi);
    const sun = new THREE.DirectionalLight(0xffe9cf, 2.1);
    sun.position.set(6, 10, 5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = sun.shadow.camera;
    s.left = -10;
    s.right = 10;
    s.top = 9;
    s.bottom = -9;
    s.near = 1;
    s.far = 30;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
    sun.shadow.radius = 4;
    this.scene.add(sun);
    this.sun = sun;
    for (const [x, y, z] of [
      [-5, 2.6, 2],
      [-5.6, 2, -3],
      [1.2, 2.8, -1],
    ]) {
      const p = new THREE.PointLight(0xffb27a, 4, 7, 2);
      p.position.set(x, y, z);
      this.scene.add(p);
    }
  }

  private room() {
    const s = this.scene;
    // floor planks
    const { tex: floorTex } = canvasTex(512, 512, (g) => {
      g.fillStyle = '#E3D5C0';
      g.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 8; i++) {
        g.fillStyle = i % 2 ? 'rgba(160,120,80,0.05)' : 'rgba(255,255,255,0.04)';
        g.fillRect(0, i * 64, 512, 64);
        g.fillStyle = 'rgba(140,100,60,0.18)';
        g.fillRect(0, i * 64, 512, 2);
        const off = (i * 173) % 512;
        g.fillRect(off, i * 64, 2, 64);
      }
    });
    floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
    floorTex.repeat.set(3.5, 2.5);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(14, 10), std(0xffffff, { map: floorTex }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    s.add(floor);
    // ground outside, so the open sides do not float in the void
    const ground = new THREE.Mesh(new THREE.CircleGeometry(40, 48), std(0xeadfcd));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    ground.receiveShadow = true;
    s.add(ground);
    // floor edge trim
    box(14.3, 0.08, 0.3, std(C.walnut), 0, 0.04, 5.0, s, false);
    box(0.3, 0.08, 10, std(C.walnut), 7.0, 0.04, 0, s, false);

    const wallM = std(C.cream);
    const T = 0.16;
    // back wall
    box(14 + T, 3, T, wallM, 0, 1.5, -5 - T / 2, s, true, true);
    // left wall with a door opening (z 3..4)
    box(T, 3, 8, wallM, -7 - T / 2, 1.5, -1, s);
    box(T, 3, 1, wallM, -7 - T / 2, 1.5, 4.5, s);
    box(T, 0.9, 1, wallM, -7 - T / 2, 2.55, 3.5, s);
    // accent band and baseboards
    const accent = std(C.orange);
    box(14, 0.5, 0.02, accent, 0, 1.45, -4.99, s, false);
    box(0.02, 0.5, 8, accent, -6.99, 1.45, -1, s, false);
    const base = std(C.walnut);
    box(14, 0.12, 0.03, base, 0, 0.06, -4.98, s, false);
    box(0.03, 0.12, 8, base, -6.98, 0.06, -1, s, false);

    // window (back wall), with a sky canvas that follows the local time
    this.windowTex = canvasTex(256, 128, () => {});
    const pane = new THREE.Mesh(
      new THREE.PlaneGeometry(4, 1.6),
      new THREE.MeshStandardMaterial({ map: this.windowTex.tex, emissive: 0xffffff, emissiveMap: this.windowTex.tex, emissiveIntensity: 0.55, roughness: 0.2 }),
    );
    pane.position.set(3.2, 1.95, -4.97);
    s.add(pane);
    const frameM = std(C.walnut);
    box(4.12, 0.08, 0.08, frameM, 3.2, 2.79, -4.95, s, false);
    box(4.12, 0.1, 0.16, frameM, 3.2, 1.12, -4.92, s, false);
    for (const x of [1.16, 3.2, 5.24]) box(0.06, 1.7, 0.08, frameM, x, 1.95, -4.95, s, false);
    this.drawWindow();

    // door: pivot on its +z edge so it swings into the room
    const pivot = new THREE.Group();
    pivot.position.set(-7.0, 0, 4.0);
    const doorM = std(C.walnut, { roughness: 0.7 });
    const panel = box(0.06, 2.1, 1.0, doorM, 0, 1.05, -0.5, pivot);
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), std(C.amber, { metalness: 0.6, roughness: 0.3 }));
    knob.position.set(0.05, 1.0, -0.85);
    pivot.add(knob);
    panel.castShadow = true;
    s.add(pivot);
    this.door = pivot;
    // door frame
    box(0.2, 0.08, 1.12, frameM, -6.95, 2.12, 3.5, s, false);
    // welcome mat
    box(0.9, 0.02, 1.1, std(C.terracotta), -6.45, 0.01, 3.5, s, false);
  }

  private buildDesks() {
    const wood = std(C.walnut, { roughness: 0.6 });
    const metal = std(C.charcoal, { roughness: 0.5 });
    const kb = std(0xe9e4dc, { roughness: 0.6 });
    let index = 0;
    for (const row of [0, 1]) {
      for (const x of DESK_X) {
        const z = row === 0 ? -2.5 : 1.0;
        const g = new THREE.Group();
        g.position.set(x, 0, z);
        g.rotation.y = row === 0 ? 0 : Math.PI;
        this.scene.add(g);
        // desk (local frame: the worker sits at +z and faces -z)
        box(1.4, 0.04, 0.7, wood, 0, 0.75, 0, g);
        for (const [lx, lz] of [
          [-0.64, -0.3],
          [0.64, -0.3],
          [-0.64, 0.3],
          [0.64, 0.3],
        ])
          cyl(0.025, 0.025, 0.73, metal, lx, 0.365, lz, g, 8);
        box(1.3, 0.3, 0.02, wood, 0, 0.55, -0.32, g, false); // modesty panel
        // monitor
        cyl(0.02, 0.02, 0.2, metal, 0, 0.87, -0.2, g, 8);
        box(0.22, 0.015, 0.14, metal, 0, 0.775, -0.2, g);
        const mon = new THREE.Group();
        mon.position.set(0, 1.12, -0.17);
        mon.rotation.x = -0.08;
        g.add(mon);
        box(0.6, 0.38, 0.035, metal, 0, 0, -0.02, mon);
        const screen = new Screen();
        const scr = new THREE.Mesh(
          new THREE.PlaneGeometry(0.56, 0.34),
          new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveMap: screen.texture, emissiveIntensity: 1.0, roughness: 0.4 }),
        );
        scr.position.z = 0.0;
        mon.add(scr);
        // soft light spill on the desk in front of an active screen
        const glow = new THREE.Mesh(
          new THREE.PlaneGeometry(0.9, 0.5),
          new THREE.MeshBasicMaterial({ color: 0x9cc8ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
        );
        glow.rotation.x = -Math.PI / 2;
        glow.position.set(0, 0.772, 0.05);
        g.add(glow);
        // keyboard + mouse
        box(0.42, 0.018, 0.13, kb, -0.02, 0.779, 0.24, g);
        const mouse = new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 8), kb);
        mouse.scale.set(1, 0.5, 1.4);
        mouse.position.set(0.3, 0.78, 0.24);
        g.add(mouse);
        // mug (tinted with the occupant's colour)
        const mug = cyl(0.04, 0.036, 0.09, std(C.warmWhite), -0.52, 0.815, 0.05, g, 12);
        // desk plant on a few desks
        if (index % 3 === 1) {
          cyl(0.05, 0.04, 0.08, std(C.terracotta), 0.55, 0.81, -0.22, g, 10);
          const leaf = new THREE.Mesh(new THREE.IcosahedronGeometry(0.08, 0), std(C.sage));
          leaf.position.set(0.55, 0.9, -0.22);
          leaf.castShadow = true;
          g.add(leaf);
        }
        // chair
        const chair = new THREE.Group();
        chair.position.set(0, 0, 0.53);
        g.add(chair);
        const seatM = std(row === 0 ? C.charcoal : 0x47474d, { roughness: 0.9 });
        box(0.46, 0.06, 0.44, seatM, 0, 0.52, 0, chair);
        box(0.44, 0.42, 0.05, seatM, 0, 0.8, 0.24, chair);
        cyl(0.025, 0.025, 0.45, metal, 0, 0.27, 0, chair, 8);
        for (let k = 0; k < 5; k++) {
          const leg = box(0.03, 0.03, 0.26, metal, 0, 0.05, 0, chair, false, false);
          leg.rotation.y = (k / 5) * Math.PI * 2;
          leg.translateZ(0.12);
        }

        const pos = g.localToWorld(new THREE.Vector3(0, 0, 0.53));
        const side = g.localToWorld(new THREE.Vector3(0.62, 0, 0.53));
        const yaw = g.rotation.y + Math.PI;
        this.desks.push({
          index,
          kind: 'desk',
          pos,
          yaw,
          side,
          node: `A${DESK_X.indexOf(x)}`,
          approach: [new THREE.Vector3(side.x, 0, AISLE_Z), side.clone()],
          screen,
          glow,
          chair,
          center: new THREE.Vector3(x, 0, z),
          chairHome: chair.position.clone(),
          monitor: mon,
          mug,
          steamAt: g.localToWorld(new THREE.Vector3(-0.52, 0.88, 0.05)),
        });
        index++;
      }
    }
  }

  private buildLounge() {
    const s = this.scene;
    const fabric = std(C.terracotta, { roughness: 0.95 });
    // rug
    const { tex: rugTex } = canvasTex(256, 256, (g) => {
      g.fillStyle = '#D97757';
      g.fillRect(0, 0, 256, 256);
      g.fillStyle = '#F3EDE3';
      g.fillRect(14, 14, 228, 228);
      g.strokeStyle = 'rgba(217,119,87,0.4)';
      g.lineWidth = 3;
      for (let i = 0; i < 6; i++) g.strokeRect(30 + i * 14, 30 + i * 14, 196 - i * 28, 196 - i * 28);
    });
    const rug = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 3.0), std(0xffffff, { map: rugTex }));
    rug.rotation.x = -Math.PI / 2;
    rug.position.set(-5.1, 0.012, 1.6);
    rug.receiveShadow = true;
    s.add(rug);
    // couch facing +x
    const couch = new THREE.Group();
    couch.position.set(-5.5, 0, 1.6);
    s.add(couch);
    box(0.7, 0.3, 2.0, fabric, 0, 0.22, 0, couch);
    box(0.62, 0.12, 0.62, std(0xd36a4a, { roughness: 1 }), 0.03, 0.42, -0.65, couch);
    box(0.62, 0.12, 0.62, std(0xd36a4a, { roughness: 1 }), 0.03, 0.42, 0, couch);
    box(0.62, 0.12, 0.62, std(0xd36a4a, { roughness: 1 }), 0.03, 0.42, 0.65, couch);
    box(0.2, 0.62, 2.0, fabric, -0.3, 0.6, 0, couch);
    for (const z of [-1.05, 1.05]) {
      const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.12, 0.5, 6, 12), fabric);
      arm.rotation.z = Math.PI / 2;
      arm.position.set(0, 0.5, z);
      arm.castShadow = true;
      couch.add(arm);
    }
    // pillow
    const pillow = box(0.12, 0.3, 0.3, std(C.sage, { roughness: 1 }), -0.15, 0.6, 0.75, couch);
    pillow.rotation.y = 0.3;
    // low table + magazines
    box(0.36, 0.04, 0.9, std(C.walnut, { roughness: 0.6 }), -4.45, 0.38, 1.6, s);
    for (const [x, z] of [
      [-4.6, 1.2],
      [-4.3, 1.2],
      [-4.6, 2.0],
      [-4.3, 2.0],
    ])
      cyl(0.02, 0.02, 0.36, std(C.charcoal), x, 0.18, z, s, 6);
    box(0.18, 0.012, 0.24, std(C.sky), -4.45, 0.406, 1.4, s, false);
    box(0.18, 0.012, 0.24, std(C.amber), -4.43, 0.418, 1.43, s, false);

    // couch seats (character root sits here facing +x)
    for (const z of [1.0, 1.6, 2.2]) {
      this.lounge.push({ kind: 'couch', pos: new THREE.Vector3(-5.38, 0, z), yaw: Math.PI / 2, node: 'LOUNGE', approach: [new THREE.Vector3(-4.9, 0, z)] });
    }
    // coffee corner
    box(0.7, 0.9, 1.7, std(C.cream), -6.62, 0.45, -3.2, s);
    box(0.74, 0.04, 1.74, std(C.walnut), -6.62, 0.92, -3.2, s);
    const mach = new THREE.Group();
    mach.position.set(-6.65, 0.94, -3.2);
    s.add(mach);
    box(0.36, 0.46, 0.36, std(C.charcoal, { roughness: 0.4 }), 0, 0.23, 0, mach);
    box(0.02, 0.06, 0.06, std(C.orange, { emissive: C.orange, emissiveIntensity: 0.8 }), 0.19, 0.36, 0.08, mach, false);
    box(0.14, 0.02, 0.16, std(0x555555), 0.12, 0.08, 0, mach, false);
    cyl(0.035, 0.03, 0.08, std(C.warmWhite), 0.12, 0.13, 0, mach, 10);
    // cups stack + jar
    cyl(0.04, 0.035, 0.18, std(C.warmWhite), -6.6, 1.03, -2.6, s, 10);
    cyl(0.07, 0.07, 0.16, std(0xbfd8e8, { transparent: true, opacity: 0.7 }), -6.6, 1.02, -3.75, s, 12);
    for (const z of [-2.75, -3.6]) {
      this.lounge.push({ kind: 'stand', pos: new THREE.Vector3(-5.85, 0, z), yaw: -Math.PI / 2, node: 'COFFEE', approach: [] });
    }
    for (const [x, z] of [
      [-4.9, 3.7],
      [-5.6, 4.1],
    ]) {
      this.lounge.push({ kind: 'stand', pos: new THREE.Vector3(x, 0, z), yaw: -Math.PI / 2 - 0.6, node: 'LOUNGE', approach: [] });
    }
  }

  private decor() {
    const s = this.scene;
    // Claude sparkle logo
    const logo = new THREE.Group();
    logo.position.set(-1.5, 2.3, -4.96);
    const lm = std(C.orange, { emissive: C.orange, emissiveIntensity: 0.25, roughness: 0.5 });
    const g1 = new THREE.ExtrudeGeometry(sparkleShape(0.5, 0.09), { depth: 0.04, bevelEnabled: false });
    const g2 = new THREE.ExtrudeGeometry(sparkleShape(0.32, 0.07), { depth: 0.04, bevelEnabled: false });
    const a = new THREE.Mesh(g1, lm);
    const b = new THREE.Mesh(g2, lm);
    b.rotation.z = Math.PI / 4;
    logo.add(a, b);
    s.add(logo);
    this.logo = logo;
    const { tex: signTex } = canvasTex(512, 96, (g) => {
      g.fillStyle = '#2B2B2E';
      g.font = 'bold 54px Georgia, serif';
      g.textAlign = 'center';
      g.fillText(APP_NAME, 256, 66);
    });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.36), new THREE.MeshStandardMaterial({ map: signTex, transparent: true, roughness: 0.8 }));
    sign.position.set(-1.5, 1.62, -4.97);
    s.add(sign);

    // wall clock
    const clock = canvasTex(128, 128, () => {});
    this.clock = clock;
    const face = new THREE.Mesh(new THREE.CircleGeometry(0.28, 32), new THREE.MeshStandardMaterial({ map: clock.tex, roughness: 0.6 }));
    face.position.set(0.6, 2.35, -4.96);
    s.add(face);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.29, 0.025, 8, 32), std(C.charcoal));
    rim.position.copy(face.position);
    s.add(rim);

    // whiteboard showing who is doing what
    const board = canvasTex(512, 300, () => {});
    this.board = board;
    box(2.1, 1.3, 0.04, std(0xbfbfc4, { metalness: 0.3, roughness: 0.4 }), -4.6, 1.75, -4.97, s, false);
    const boardFace = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 1.2), new THREE.MeshStandardMaterial({ map: board.tex, roughness: 0.35 }));
    boardFace.position.set(-4.6, 1.75, -4.94);
    s.add(boardFace);
    box(1.0, 0.04, 0.08, std(C.charcoal), -4.6, 1.12, -4.92, s, false);
    this.drawBoard([]);
    for (const x of [-5.0, -4.15]) {
      this.boards.push({ kind: 'board', pos: new THREE.Vector3(x, 0, -4.35), yaw: Math.PI, node: 'SIDE_N', approach: [] });
    }

    // bookshelf on the left wall
    const shelf = new THREE.Group();
    shelf.position.set(-6.8, 0, -0.6);
    s.add(shelf);
    box(0.35, 1.8, 1.2, std(C.walnut), 0, 0.9, 0, shelf);
    const bookColors = [C.orange, C.sage, C.sky, C.cream, C.terracotta, C.charcoal, C.amber];
    for (let r = 0; r < 4; r++) {
      box(0.32, 0.03, 1.12, std(0x6f4a2f), 0.02, 0.2 + r * 0.42, 0, shelf, false);
      let z = -0.5;
      let k = r * 3;
      while (z < 0.48) {
        const w = 0.05 + ((k * 37) % 5) * 0.012;
        const h = 0.26 + ((k * 53) % 4) * 0.025;
        box(0.22, h, w, std(bookColors[k % bookColors.length]), 0.06, 0.22 + r * 0.42 + h / 2, z + w / 2, shelf, false);
        z += w + 0.01;
        k++;
      }
    }

    // potted plants
    for (const [x, z, sc] of [
      [-6.5, -1.9, 1.1],
      [6.4, -4.4, 1.3],
      [-3.2, 4.3, 1.0],
      [6.4, 3.6, 0.9],
    ]) {
      const p = new THREE.Group();
      p.position.set(x, 0, z);
      p.scale.setScalar(sc);
      cyl(0.18, 0.14, 0.36, std(C.terracotta), 0, 0.18, 0, p, 14);
      const leaves = new THREE.Group();
      leaves.position.y = 0.36;
      for (let i = 0; i < 7; i++) {
        const l = new THREE.Mesh(new THREE.IcosahedronGeometry(0.14 + (i % 3) * 0.03, 0), std(i % 2 ? C.sage : 0x7d9878, { flatShading: true }));
        const a = (i / 7) * Math.PI * 2;
        l.position.set(Math.cos(a) * 0.12, 0.15 + (i % 3) * 0.14, Math.sin(a) * 0.12);
        l.castShadow = true;
        leaves.add(l);
      }
      p.add(leaves);
      s.add(p);
      this.plants.push(leaves);
    }

  }

  private buildManager() {
    const s = this.scene;
    const g = new THREE.Group();
    g.position.set(2.0, 0, 3.75);
    s.add(g);
    const wood = std(0x6f4a2f, { roughness: 0.55 });
    const metal = std(C.charcoal, { roughness: 0.4, metalness: 0.2 });
    // big desk (worker side is +z, facing the office at -z)
    box(2.2, 0.06, 0.85, wood, 0, 0.76, 0, g);
    box(2.1, 0.62, 0.05, wood, 0, 0.42, -0.38, g); // front panel faces visitors
    for (const x of [-1.02, 1.02]) box(0.08, 0.73, 0.8, wood, x, 0.365, 0, g);
    // nameplate facing visitors
    const { tex: plateTex } = canvasTex(256, 64, (c) => {
      c.fillStyle = '#2B2B2E';
      c.fillRect(0, 0, 256, 64);
      c.fillStyle = '#F2B84B';
      c.font = 'bold 30px Georgia, serif';
      c.textAlign = 'center';
      c.fillText('MANAGER', 128, 43);
    });
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.11, 0.06), [metal, metal, metal, metal, metal, new THREE.MeshStandardMaterial({ map: plateTex, roughness: 0.4 })]);
    plate.position.set(0, 0.84, -0.33);
    plate.rotation.set(-0.35, Math.PI, 0);
    g.add(plate);
    // two monitors with a "dispatch" screen
    const screen = canvasTex(512, 320, () => {});
    this.manager = { center: g.position.clone(), seat: new THREE.Vector3(), seatYaw: Math.PI, chair: new THREE.Group(), bell: new THREE.Group(), screen, visitors: [] };
    for (const [x, ry] of [
      [-0.38, 0.18],
      [0.38, -0.18],
    ]) {
      const mon = new THREE.Group();
      mon.position.set(x, 1.13, -0.12);
      mon.rotation.set(-0.08, ry, 0);
      g.add(mon);
      box(0.62, 0.4, 0.035, metal, 0, 0, -0.02, mon);
      const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.58, 0.36), new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveMap: screen.tex, emissiveIntensity: 0.95 }));
      mon.add(scr);
      cyl(0.02, 0.02, 0.2, metal, x, 0.88, -0.14, g, 8);
    }
    box(0.42, 0.018, 0.13, std(0xe9e4dc), 0, 0.8, 0.2, g);
    // service bell: ring it to call an agent
    const bell = new THREE.Group();
    bell.position.set(0.82, 0.79, 0.05);
    cyl(0.07, 0.075, 0.015, std(0x8a6a3a, { metalness: 0.5, roughness: 0.3 }), 0, 0.007, 0, bell, 16);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.055, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), std(C.amber, { metalness: 0.8, roughness: 0.25 }));
    dome.position.y = 0.015;
    dome.castShadow = true;
    bell.add(dome);
    cyl(0.008, 0.008, 0.03, std(C.amber, { metalness: 0.8 }), 0, 0.08, 0, bell, 8);
    g.add(bell);
    // lamp + mug + small plant
    cyl(0.07, 0.08, 0.02, metal, -0.85, 0.8, -0.2, g, 12);
    const arm = cyl(0.01, 0.01, 0.4, metal, -0.85, 1.0, -0.2, g, 6);
    arm.rotation.z = 0.25;
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.12, 14, 1, true), std(C.orange, { side: THREE.DoubleSide, emissive: C.amber, emissiveIntensity: 0.3 }));
    shade.position.set(-0.9, 1.2, -0.2);
    g.add(shade);
    cyl(0.04, 0.036, 0.09, std(C.orange), 0.55, 0.835, 0.12, g, 12);
    // tall leather chair
    const chair = new THREE.Group();
    chair.position.set(0, 0, 0.6);
    g.add(chair);
    const leather = std(0x7a3324, { roughness: 0.6 });
    box(0.56, 0.08, 0.5, leather, 0, 0.52, 0, chair);
    box(0.56, 0.78, 0.09, leather, 0, 0.95, 0.27, chair);
    box(0.08, 0.06, 0.4, leather, -0.3, 0.68, 0.02, chair);
    box(0.08, 0.06, 0.4, leather, 0.3, 0.68, 0.02, chair);
    cyl(0.03, 0.03, 0.45, metal, 0, 0.26, 0, chair, 8);
    for (let k = 0; k < 5; k++) {
      const leg = box(0.035, 0.03, 0.3, metal, 0, 0.05, 0, chair, false, false);
      leg.rotation.y = (k / 5) * Math.PI * 2;
      leg.translateZ(0.14);
    }
    this.manager.chair = chair;
    this.manager.bell = bell;
    this.manager.seat = g.localToWorld(new THREE.Vector3(0, 0, 0.6));
    // where called agents stand, facing the manager
    for (const x of [1.3, 2.0, 2.7]) {
      this.manager.visitors.push({ kind: 'stand', pos: new THREE.Vector3(x, 0, 2.95), yaw: 0, node: 'FRONT_M', approach: [] });
    }
    this.drawManagerScreen([]);
  }

  /** Ding! */
  ringBell() {
    this.bellT = 0;
  }

  drawManagerScreen(lines: string[]) {
    const c = this.manager.screen.g;
    c.fillStyle = '#1B1E24';
    c.fillRect(0, 0, 512, 320);
    c.fillStyle = '#2B2B2E';
    c.fillRect(0, 0, 512, 34);
    c.fillStyle = '#F3EDE3';
    c.font = 'bold 18px ui-monospace, Consolas, monospace';
    c.fillText('DISPATCH', 14, 23);
    drawSparkle(c, 490, 17, 10, '#D97757', 0);
    c.font = '16px ui-monospace, Consolas, monospace';
    if (!lines.length) {
      c.fillStyle = '#6B7280';
      c.fillText('No tasks yet. Ring the bell!', 14, 70);
    }
    lines.slice(0, 11).forEach((l, i) => {
      c.fillStyle = l.startsWith('✓') ? '#39D353' : l.startsWith('✗') ? '#FF6B6B' : '#E8DCC8';
      c.fillText(l.length > 46 ? l.slice(0, 45) + '…' : l, 14, 70 + i * 23);
    });
    this.manager.screen.tex.needsUpdate = true;
  }

  private graph() {
    const n = this.nav;
    n.add('DOOR_OUT', this.doorOut.x, this.doorOut.z);
    n.add('DOOR_IN', this.doorIn.x, this.doorIn.z);
    n.add('LOUNGE', -4.9, 2.9);
    n.add('SIDE_S', -3.9, 2.9);
    n.add('SIDE_M', -3.9, AISLE_Z);
    n.add('SIDE_N', -3.9, -3.5);
    n.add('COFFEE', -5.3, -3.5);
    n.add('FRONT_M', 2.0, 2.9);
    DESK_X.forEach((x, i) => n.add(`A${i}`, x, AISLE_Z));
    n.link('DOOR_OUT', 'DOOR_IN');
    n.link('DOOR_IN', 'LOUNGE');
    n.link('DOOR_IN', 'SIDE_S');
    n.link('LOUNGE', 'SIDE_S');
    n.link('SIDE_S', 'SIDE_M');
    n.link('SIDE_M', 'SIDE_N');
    n.link('SIDE_N', 'COFFEE');
    n.link('SIDE_S', 'FRONT_M');
    n.link('SIDE_M', 'A0');
    for (let i = 0; i < DESK_X.length - 1; i++) n.link(`A${i}`, `A${i + 1}`);
  }

  /** Things that move or get swapped at runtime: never merged into static geometry. */
  dynamicObjects(): THREE.Object3D[] {
    const list: THREE.Object3D[] = [this.door, this.logo, ...this.plants];
    for (const d of this.desks) list.push(d.chair, d.mug, d.glow, d.monitor);
    list.push(this.manager.chair, this.manager.bell);
    return list;
  }

  /** Full walk from a position to a spot: graph route, then the spot's approach points. */
  pathTo(from: THREE.Vector3, spot: Spot | null, node?: string): THREE.Vector3[] {
    const target = spot ? spot.node : node!;
    const start = this.nav.nearest(from);
    const pts = this.nav.route(start, target);
    if (spot) pts.push(...spot.approach.map((p) => p.clone()));
    return pts;
  }

  update(dt: number, t: number, nearDoor: boolean) {
    // door
    const target = nearDoor ? -1.45 : 0;
    this.doorAngle += (target - this.doorAngle) * (1 - Math.exp(-dt / 0.12));
    this.door.rotation.y = this.doorAngle;
    // logo breathing
    this.logo.scale.setScalar(1 + 0.03 * Math.sin(t * 1.2));
    this.logo.rotation.z = Math.sin(t * 0.1) * 0.08;
    // the bell bounces when rung
    if (this.bellT >= 0) {
      this.bellT += dt;
      const k = Math.exp(-this.bellT * 6) * Math.sin(this.bellT * 40);
      this.manager.bell.scale.set(1 + 0.15 * k, 1 - 0.2 * Math.abs(k), 1 + 0.15 * k);
      if (this.bellT > 0.8) {
        this.bellT = -1;
        this.manager.bell.scale.set(1, 1, 1);
      }
    }
    // plants sway
    this.plants.forEach((p, i) => {
      p.rotation.z = 0.025 * Math.sin(t * 0.8 + i);
      p.rotation.x = 0.02 * Math.sin(t * 0.6 + i * 2);
    });
    for (const d of this.desks) {
      d.screen.update(dt);
      const m = d.glow.material as THREE.MeshBasicMaterial;
      m.opacity += ((d.screen.active ? 0.07 : 0) - m.opacity) * Math.min(1, dt * 4);
    }
    const sec = Math.floor(Date.now() / 1000);
    if (sec !== this.lastSecond) {
      this.lastSecond = sec;
      this.drawClock();
      if (sec % 60 === 0) this.drawWindow();
    }
  }

  private drawClock() {
    const g = this.clock.g;
    const d = new Date();
    g.fillStyle = '#FAF7F2';
    g.fillRect(0, 0, 128, 128);
    g.save();
    g.translate(64, 64);
    for (let i = 0; i < 12; i++) {
      g.rotate(Math.PI / 6);
      g.fillStyle = i % 3 === 2 ? '#D97757' : '#2B2B2E';
      g.fillRect(-2, -58, 4, i % 3 === 2 ? 12 : 7);
    }
    const hand = (a: number, len: number, w: number, c: string) => {
      g.save();
      g.rotate(a);
      g.fillStyle = c;
      g.fillRect(-w / 2, -len, w, len + 8);
      g.restore();
    };
    const h = d.getHours() % 12;
    const m = d.getMinutes();
    const s = d.getSeconds();
    hand(((h + m / 60) / 12) * Math.PI * 2, 32, 6, '#2B2B2E');
    hand(((m + s / 60) / 60) * Math.PI * 2, 46, 4, '#2B2B2E');
    hand((s / 60) * Math.PI * 2, 50, 2, '#D97757');
    g.beginPath();
    g.arc(0, 0, 5, 0, Math.PI * 2);
    g.fill();
    g.restore();
    this.clock.tex.needsUpdate = true;
  }

  private drawWindow() {
    const g = this.windowTex.g;
    const h = new Date().getHours() + new Date().getMinutes() / 60;
    const day = Math.max(0, Math.sin(((h - 6) / 12) * Math.PI)); // 0 at night, 1 at noon
    const dusk = Math.max(0, 1 - Math.abs(h - 18.5) / 1.5) + Math.max(0, 1 - Math.abs(h - 6.5) / 1.5);
    const top = lerpColor('#1B2440', '#8EC5E8', day);
    const bottom = lerpColor('#3A3F66', '#DDEFF8', day);
    const grad = g.createLinearGradient(0, 0, 0, 128);
    grad.addColorStop(0, top);
    grad.addColorStop(1, dusk > 0 ? lerpColor(bottom, '#F2A65A', Math.min(1, dusk)) : bottom);
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 128);
    if (day > 0.15) {
      g.fillStyle = 'rgba(255,255,255,0.85)';
      for (const [x, y, r] of [
        [50, 40, 16],
        [70, 36, 20],
        [92, 42, 14],
        [180, 60, 12],
        [196, 56, 16],
      ]) {
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.fill();
      }
    } else {
      g.fillStyle = '#FFF6D8';
      for (let i = 0; i < 30; i++) g.fillRect((i * 97) % 256, (i * 53) % 90, 2, 2);
      g.beginPath();
      g.arc(200, 34, 12, 0, Math.PI * 2);
      g.fill();
    }
    // distant city silhouette
    g.fillStyle = day > 0.15 ? 'rgba(120,140,160,0.55)' : 'rgba(20,24,40,0.9)';
    for (let i = 0; i < 16; i++) {
      const w = 12 + ((i * 31) % 10);
      const hh = 20 + ((i * 47) % 36);
      g.fillRect(i * 16, 128 - hh, w, hh);
      if (day <= 0.15) {
        g.fillStyle = 'rgba(255,214,140,0.8)';
        for (let k = 0; k < 3; k++) g.fillRect(i * 16 + 3 + k * 3, 128 - hh + 6 + k * 7, 2, 2);
        g.fillStyle = 'rgba(20,24,40,0.9)';
      }
    }
    this.windowTex.tex.needsUpdate = true;
    this.sun.intensity = 0.9 + 1.3 * day;
    this.hemi.intensity = 0.55 + 0.3 * day;
  }

  drawBoard(items: { name: string; text: string; color: string; done?: boolean }[]) {
    const g = this.board.g;
    g.fillStyle = '#FBFBF8';
    g.fillRect(0, 0, 512, 300);
    g.fillStyle = '#2B2B2E';
    g.font = 'bold 30px "Comic Sans MS", "Segoe Print", cursive';
    g.fillText('Today', 24, 44);
    drawSparkle(g, 140, 34, 13, '#D97757', 0);
    g.font = '21px "Comic Sans MS", "Segoe Print", cursive';
    if (!items.length) {
      g.fillStyle = '#9CA3AF';
      g.fillText('Quiet office. Start a Claude session!', 24, 100);
    }
    items.slice(0, 7).forEach((it, i) => {
      const y = 90 + i * 30;
      g.fillStyle = it.color;
      g.fillText(it.done ? '✓' : '•', 24, y);
      g.fillStyle = '#2B2B2E';
      const txt = `${it.name}: ${it.text}`;
      g.fillText(txt.length > 38 ? txt.slice(0, 37) + '…' : txt, 50, y);
    });
    this.board.tex.needsUpdate = true;
  }
}

function lerpColor(a: string, b: string, u: number) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (s: number) => Math.round(((pa >> s) & 255) + ((((pb >> s) & 255) - ((pa >> s) & 255)) * u));
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}
