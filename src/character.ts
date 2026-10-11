// Procedural chibi character: a joint hierarchy built from primitives, with an expressive face.
import * as THREE from 'three';
import { C, SKIN, HAIR, hash, rng } from './palette';

export type JointName =
  | 'hips'
  | 'spine'
  | 'neck'
  | 'head'
  | 'shL'
  | 'elL'
  | 'shR'
  | 'elR'
  | 'hipL'
  | 'knL'
  | 'hipR'
  | 'knR';

export const JOINTS: JointName[] = ['hips', 'spine', 'neck', 'head', 'shL', 'elL', 'shR', 'elR', 'hipL', 'knL', 'hipR', 'knR'];

export type Gender = 'm' | 'f';

export type Expression = 'neutral' | 'happy' | 'focus' | 'concern' | 'surprise' | 'curious' | 'sleepy' | 'laugh';

export interface Rig {
  root: THREE.Group; // positioned/rotated in the world
  body: THREE.Group; // child of root: vertical offset + squash
  joints: Record<JointName, THREE.Object3D>;
  handR: THREE.Object3D;
  handL: THREE.Object3D;
  mug: THREE.Object3D;
  phone: THREE.Object3D;
  badge?: THREE.Object3D;
  antenna?: THREE.Object3D;
  eyes: THREE.Object3D[];
  brows: THREE.Mesh[];
  mouthSmile: THREE.Mesh;
  mouthO: THREE.Mesh;
  mouthFlat: THREE.Mesh;
  materials: THREE.MeshStandardMaterial[];
  accent: number;
  variant: number;
  gender: Gender;
  browBase: number;
}

export const HIPS_Y = 0.4;

const mats = new Map<string, THREE.MeshStandardMaterial>();
function mat(color: number, opts: { emissive?: number; ei?: number; rough?: number } = {}) {
  const key = `${color}-${opts.emissive ?? 0}-${opts.ei ?? 0}-${opts.rough ?? 0.75}`;
  let m = mats.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color,
      roughness: opts.rough ?? 0.75,
      metalness: 0,
      emissive: opts.emissive ?? 0x000000,
      emissiveIntensity: opts.ei ?? 0,
    });
    mats.set(key, m);
  }
  return m;
}

function mesh(geo: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0, shadow = true) {
  const o = new THREE.Mesh(geo, m);
  o.position.set(x, y, z);
  o.castShadow = shadow;
  o.receiveShadow = false;
  return o;
}

function joint(parent: THREE.Object3D, x: number, y: number, z: number) {
  const j = new THREE.Group();
  j.position.set(x, y, z);
  parent.add(j);
  return j;
}

/** 4-point sparkle star shape (Claude-ish). */
export function sparkleShape(outer: number, inner: number) {
  const s = new THREE.Shape();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 2;
    const r = i % 2 === 0 ? outer : inner;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) s.moveTo(x, y);
    else s.lineTo(x, y);
  }
  s.closePath();
  return s;
}

interface VariantDef {
  shirt: number;
  pants: number;
  accessory: 'badge' | 'headphones' | 'glasses' | 'beanie' | 'antenna' | 'hair' | 'catEars' | 'cap' | 'scarf';
}

export const VARIANTS: VariantDef[] = [
  { shirt: C.orange, pants: C.charcoal, accessory: 'badge' },
  { shirt: C.sage, pants: 0x4a5a48, accessory: 'headphones' },
  { shirt: C.sky, pants: C.charcoal, accessory: 'glasses' },
  { shirt: C.charcoal, pants: 0x5b4636, accessory: 'beanie' },
  { shirt: C.cream, pants: 0x6a7c8f, accessory: 'antenna' },
  { shirt: C.terracotta, pants: C.charcoal, accessory: 'hair' },
  { shirt: C.walnut, pants: 0x3c3c40, accessory: 'catEars' },
  { shirt: C.mint, pants: 0x4d5560, accessory: 'cap' },
  // the player: amber hoodie, navy pants, terracotta scarf, mint backpack, cream sneakers
  { shirt: C.amber, pants: C.navy, accessory: 'scarf' },
];

export const PLAYER_VARIANT = 8;

export function variantFor(role: 'lead' | 'sub' | 'player', key: string) {
  if (role === 'player') return PLAYER_VARIANT;
  return role === 'lead' ? 0 : 1 + (hash(key) % 7);
}

export function buildCharacter(variant: number, seedKey: string, gender: Gender = 'm'): Rig {
  const v = VARIANTS[variant];
  const r = rng(hash(seedKey));
  const skin = mat(SKIN[Math.floor(r() * SKIN.length)], { rough: 0.6 });
  const hairColor = HAIR[Math.floor(r() * HAIR.length)];
  const hairM = mat(hairColor, { rough: 0.9 });
  const shirt = mat(v.shirt);
  const pants = mat(v.pants);
  const shoe = mat(v.accessory === 'scarf' ? 0xf3ede3 : 0x3a3330);
  const black = mat(0x1a1a1c, { rough: 0.3 });
  const white = mat(0xffffff, { emissive: 0xffffff, ei: 0.6 });

  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  // --- hips & legs
  const hips = joint(body, 0, HIPS_Y, 0);
  const pelvis = mesh(new THREE.SphereGeometry(0.15, 20, 14), pants);
  pelvis.scale.set(1.0, 0.62, 0.8);
  hips.add(pelvis);

  const legs: Record<string, THREE.Object3D> = {};
  for (const side of ['L', 'R'] as const) {
    const sx = side === 'L' ? 0.075 : -0.075;
    const hip = joint(hips, sx, -0.04, 0);
    hip.add(mesh(new THREE.CapsuleGeometry(0.062, 0.1, 6, 12), pants, 0, -0.085, 0));
    const knee = joint(hip, 0, -0.17, 0);
    knee.add(mesh(new THREE.CapsuleGeometry(0.056, 0.07, 6, 12), pants, 0, -0.06, 0));
    const foot = mesh(new THREE.BoxGeometry(0.1, 0.065, 0.17), shoe, 0, -0.145, 0.03);
    knee.add(foot);
    legs['hip' + side] = hip;
    legs['kn' + side] = knee;
  }

  // --- torso
  const spine = joint(hips, 0, 0.05, 0);
  const torso = mesh(new THREE.CapsuleGeometry(0.15, 0.08, 8, 18), shirt, 0, 0.15, 0);
  torso.scale.set(1.0, 1.0, 0.85);
  spine.add(torso);
  if (v.accessory === 'badge') {
    // hoodie drawstrings + pocket
    const cord = mat(C.cream);
    for (const x of [-0.04, 0.04]) spine.add(mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.1), cord, x, 0.2, 0.125));
    const pocket = mesh(new THREE.BoxGeometry(0.16, 0.06, 0.02), mat(C.terracotta), 0, 0.06, 0.12);
    spine.add(pocket);
  }

  // --- arms
  const arms: Record<string, THREE.Object3D> = {};
  const hands: Record<string, THREE.Object3D> = {};
  for (const side of ['L', 'R'] as const) {
    const sx = side === 'L' ? 0.185 : -0.185;
    const sh = joint(spine, sx, 0.26, 0);
    sh.add(mesh(new THREE.CapsuleGeometry(0.05, 0.08, 6, 12), shirt, 0, -0.075, 0));
    const el = joint(sh, 0, -0.15, 0);
    el.add(mesh(new THREE.CapsuleGeometry(0.045, 0.06, 6, 12), shirt, 0, -0.06, 0));
    const hand = joint(el, 0, -0.135, 0);
    hand.add(mesh(new THREE.SphereGeometry(0.052, 14, 10), skin));
    arms['sh' + side] = sh;
    arms['el' + side] = el;
    hands[side] = hand;
  }

  // props held in the right hand
  const mug = new THREE.Group();
  mug.add(mesh(new THREE.CylinderGeometry(0.04, 0.036, 0.09, 14), mat(C.warmWhite)));
  const handle = mesh(new THREE.TorusGeometry(0.025, 0.007, 6, 12), mat(C.warmWhite));
  handle.position.set(0.045, 0, 0);
  mug.add(handle);
  mug.position.set(0, -0.03, 0.04);
  mug.visible = false;
  hands.R.add(mug);
  const phone = mesh(new THREE.BoxGeometry(0.075, 0.13, 0.012), mat(C.charcoal), 0, -0.02, 0.05);
  const phoneScreen = mesh(new THREE.PlaneGeometry(0.062, 0.11), mat(0x9fd3ff, { emissive: 0x6fb7ff, ei: 0.8 }), 0, 0, 0.007, false);
  phone.add(phoneScreen);
  phone.visible = false;
  hands.L.add(phone);

  // --- head
  const neck = joint(spine, 0, 0.32, 0);
  neck.add(mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.06), skin, 0, 0.01, 0));
  const head = joint(neck, 0, 0.04, 0);
  const HC = 0.22; // head center height above the head joint
  const skull = mesh(new THREE.SphereGeometry(0.25, 28, 20), skin, 0, HC, 0);
  skull.scale.set(1, 0.92, 0.95);
  head.add(skull);

  // hair cap (most variants), shaped as a top hemisphere slightly larger than the skull
  const hairCap = mesh(new THREE.SphereGeometry(0.262, 28, 14, 0, Math.PI * 2, 0, Math.PI * 0.42), hairM, 0, HC + 0.01, -0.01);
  hairCap.scale.set(1, 0.95, 1);
  hairCap.rotation.x = -0.25;
  head.add(hairCap);

  // face
  const face = new THREE.Group();
  face.position.set(0, HC, 0.225);
  head.add(face);
  const eyes: THREE.Object3D[] = [];
  for (const x of [-0.085, 0.085]) {
    const eye = new THREE.Group();
    eye.position.set(x, 0.0, 0);
    const ball = mesh(new THREE.SphereGeometry(0.036, 14, 10), black, 0, 0, 0, false);
    ball.scale.set(1, 1.3, 0.5);
    eye.add(ball);
    const glint = mesh(new THREE.SphereGeometry(0.012, 8, 6), white, 0.012, 0.016, 0.018, false);
    eye.add(glint);
    face.add(eye);
    eyes.push(eye);
  }
  const brows: THREE.Mesh[] = [];
  for (const x of [-0.085, 0.085]) {
    const b = mesh(new THREE.BoxGeometry(0.07, 0.015, 0.012), hairM, x, 0.075, -0.005, false);
    face.add(b);
    brows.push(b);
  }
  const mouthM = mat(gender === 'f' ? 0x9b3b3e : 0x5a2a22, { rough: 0.5 });
  const mouthSmile = mesh(new THREE.TorusGeometry(0.03, 0.007, 6, 16, Math.PI), mouthM, 0, -0.075, -0.01, false);
  mouthSmile.rotation.z = Math.PI;
  face.add(mouthSmile);
  const mouthO = mesh(new THREE.TorusGeometry(0.018, 0.007, 6, 16), mouthM, 0, -0.08, -0.01, false);
  face.add(mouthO);
  const mouthFlat = mesh(new THREE.BoxGeometry(0.045, 0.01, 0.01), mouthM, 0, -0.08, -0.008, false);
  face.add(mouthFlat);
  const blush = new THREE.MeshStandardMaterial({ color: C.orange, transparent: true, opacity: gender === 'f' ? 0.5 : 0.35, roughness: 1 });
  for (const x of [-0.14, 0.14]) {
    const ch = mesh(new THREE.SphereGeometry(0.03, 10, 8), blush, x, -0.045, -0.03, false);
    ch.scale.set(1, 0.6, 0.3);
    face.add(ch);
  }

  // accessories
  let badge: THREE.Object3D | undefined;
  let antenna: THREE.Object3D | undefined;
  const acc = v.accessory;
  if (acc === 'badge') {
    const g = new THREE.ExtrudeGeometry(sparkleShape(0.085, 0.022), { depth: 0.015, bevelEnabled: false });
    g.center();
    badge = mesh(g, mat(C.orange, { emissive: C.orange, ei: 0.7 }), 0, HC + 0.42, 0, false);
    head.add(badge);
  } else if (acc === 'headphones') {
    const band = mesh(new THREE.TorusGeometry(0.265, 0.022, 8, 24, Math.PI), mat(C.charcoal), 0, HC, 0);
    head.add(band);
    for (const x of [-0.255, 0.255]) {
      const cup = mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.05, 16), mat(C.orange), x, HC - 0.01, 0);
      cup.rotation.z = Math.PI / 2;
      head.add(cup);
    }
  } else if (acc === 'glasses') {
    const fm = mat(C.charcoal, { rough: 0.4 });
    for (const x of [-0.085, 0.085]) {
      const ring = mesh(new THREE.TorusGeometry(0.058, 0.007, 6, 18), fm, x, 0, 0.02, false);
      face.add(ring);
    }
    face.add(mesh(new THREE.BoxGeometry(0.05, 0.008, 0.008), fm, 0, 0.01, 0.025, false));
  } else if (acc === 'beanie') {
    hairCap.visible = false;
    const bm = mat(C.terracotta, { rough: 0.95 });
    const cap = mesh(new THREE.SphereGeometry(0.268, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.5), bm, 0, HC + 0.03, 0);
    head.add(cap);
    const rim = mesh(new THREE.TorusGeometry(0.255, 0.03, 8, 24), bm, 0, HC + 0.04, 0);
    rim.rotation.x = Math.PI / 2;
    head.add(rim);
    head.add(mesh(new THREE.SphereGeometry(0.06, 12, 10), mat(C.cream, { rough: 1 }), 0, HC + 0.3, 0));
  } else if (acc === 'antenna') {
    antenna = new THREE.Group();
    antenna.position.set(0, HC + 0.22, 0);
    antenna.add(mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.15), mat(C.charcoal), 0, 0.075, 0));
    antenna.add(mesh(new THREE.SphereGeometry(0.032, 12, 10), mat(C.orange, { emissive: C.orange, ei: 0.6 }), 0, 0.16, 0));
    head.add(antenna);
  } else if (acc === 'hair') {
    const swoop = mesh(new THREE.SphereGeometry(0.2, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), hairM, 0.06, HC + 0.13, 0.08);
    swoop.rotation.set(0.4, 0, -0.4);
    swoop.scale.set(1, 0.6, 0.9);
    head.add(swoop);
  } else if (acc === 'catEars') {
    const em = mat(v.shirt);
    for (const x of [-0.15, 0.15]) {
      const ear = mesh(new THREE.ConeGeometry(0.065, 0.11, 4), em, x, HC + 0.21, 0);
      ear.rotation.z = -x * 2;
      head.add(ear);
    }
  } else if (acc === 'scarf') {
    const sm = mat(C.terracotta, { rough: 0.95 });
    const wrap = mesh(new THREE.TorusGeometry(0.12, 0.035, 8, 20), sm, 0, 0.02, 0);
    wrap.rotation.x = Math.PI / 2;
    neck.add(wrap);
    const tail = mesh(new THREE.BoxGeometry(0.07, 0.18, 0.03), sm, 0.05, -0.08, -0.12);
    tail.rotation.z = 0.15;
    neck.add(tail);
    const pack = mesh(new THREE.BoxGeometry(0.2, 0.26, 0.1), mat(C.mint), 0, 0.14, -0.17);
    spine.add(pack);
    spine.add(mesh(new THREE.BoxGeometry(0.14, 0.08, 0.03), mat(0x8cc4ab), 0, 0.08, -0.225));
  } else if (acc === 'cap') {
    const cm = mat(C.terracotta);
    head.add(mesh(new THREE.SphereGeometry(0.265, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.45), cm, 0, HC + 0.02, 0));
    head.add(mesh(new THREE.BoxGeometry(0.24, 0.02, 0.16), cm, 0, HC + 0.06, -0.27));
  }

  // ---- gendered hair & face details (all compatible with the accessories above)
  const style = hash(seedKey + ':hair') % 3;
  const hairD = hairM.clone();
  hairD.side = THREE.DoubleSide;
  const covered = acc === 'beanie' || acc === 'cap';
  if (gender === 'f') {
    // back mane wrapping from cheek to cheek
    const mane = mesh(new THREE.SphereGeometry(0.25, 24, 16, Math.PI - 0.35, Math.PI + 0.7), hairD, 0, HC - 0.08, -0.04);
    if (style === 0) {
      mane.scale.set(1, 1.3, 0.95);
      for (const s of [-1, 1]) {
        const lock = mesh(new THREE.CapsuleGeometry(0.055, 0.22, 4, 10), hairM, s * 0.225, HC - 0.16, 0.09);
        lock.rotation.z = -s * 0.08;
        head.add(lock);
      }
    } else if (style === 1) {
      mane.scale.set(1.05, 1.05, 1.0);
      mane.position.set(0, HC - 0.03, -0.03);
    } else {
      mane.scale.set(1, 0.9, 0.9);
      const tail = mesh(new THREE.CapsuleGeometry(0.07, 0.26, 4, 10), hairM, 0, HC - 0.1, -0.28);
      tail.rotation.x = 0.35;
      head.add(tail);
      const tie = mesh(new THREE.TorusGeometry(0.045, 0.012, 6, 14), mat(v.shirt), 0, HC + 0.02, -0.25, false);
      head.add(tie);
    }
    head.add(mane);
    if (acc !== 'hair') {
      const s = hash(seedKey + ':bangs') & 1 ? 1 : -1;
      const bangs = mesh(new THREE.SphereGeometry(0.12, 14, 10), hairM, s * 0.09, HC + 0.14, 0.17, false);
      bangs.scale.set(1.2, 0.5, 0.7);
      bangs.rotation.z = -s * 0.5;
      head.add(bangs);
    }
    // a little taller eyes with one lash each
    eyes.forEach((eye, i) => {
      (eye.children[0] as THREE.Mesh).scale.set(1, 1.4, 0.5);
      const s = i === 0 ? -1 : 1;
      const lash = mesh(new THREE.BoxGeometry(0.024, 0.006, 0.006), black, s * 0.032, 0.046, 0.012, false);
      lash.rotation.z = -s * 0.7;
      eye.add(lash);
    });
    for (const b of brows) b.scale.set(0.93, 0.75, 1);
  } else {
    if (style === 1 && !covered) {
      const quiff = mesh(new THREE.SphereGeometry(0.11, 14, 10), hairM, 0.02, HC + 0.25, 0.1);
      quiff.scale.set(1.3, 0.7, 0.8);
      quiff.rotation.x = 0.3;
      head.add(quiff);
    } else if (style === 2 && !covered) {
      for (let k = 0; k < 6; k++) {
        const a = ((k * 60 + 30) * Math.PI) / 180;
        head.add(mesh(new THREE.SphereGeometry(0.065, 10, 8), hairM, Math.cos(a) * 0.21, HC + 0.15, Math.sin(a) * 0.21 - 0.02));
      }
    }
    const beard = hash(seedKey + ':beard') % 10;
    if (beard < 3) {
      const bm = beard < 2 ? mat(new THREE.Color(hairColor).multiplyScalar(0.8).getHex(), { rough: 1 }) : new THREE.MeshStandardMaterial({ color: hairColor, transparent: true, opacity: 0.45, roughness: 1 });
      const b = mesh(new THREE.SphereGeometry(0.255, 24, 12, Math.PI / 2 - 1.3, 2.6, Math.PI * 0.64, Math.PI * 0.26), bm, 0, HC, 0, false);
      b.scale.set(1, 0.92, 0.95);
      head.add(b);
    }
  }

  const joints = {
    hips,
    spine,
    neck,
    head,
    shL: arms.shL,
    elL: arms.elL,
    shR: arms.shR,
    elR: arms.elR,
    hipL: legs.hipL,
    knL: legs.knL,
    hipR: legs.hipR,
    knR: legs.knR,
  } as Record<JointName, THREE.Object3D>;

  // per-character transparent copies so a character can fade out on exit without touching others
  const materials: THREE.MeshStandardMaterial[] = [];
  const cache = new Map<THREE.Material, THREE.MeshStandardMaterial>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const src = m.material as THREE.MeshStandardMaterial;
    let c = cache.get(src);
    if (!c) {
      c = src.clone();
      cache.set(src, c);
      materials.push(c);
    }
    m.material = c;
  });

  return {
    root,
    body,
    joints,
    handR: hands.R,
    handL: hands.L,
    mug,
    phone,
    badge,
    antenna,
    eyes,
    brows,
    mouthSmile,
    mouthO,
    mouthFlat,
    materials,
    accent: v.shirt,
    variant,
    gender,
    browBase: gender === 'f' ? 0.1 : 0,
  };
}

export function setExpression(rig: Rig, e: Expression) {
  const [bl, br] = rig.brows;
  let rot = 0;
  let dy = 0;
  switch (e) {
    case 'happy':
      dy = 0.015;
      break;
    case 'focus':
      rot = 0.18;
      dy = -0.008;
      break;
    case 'curious':
      rot = 0.25;
      dy = 0.01;
      break;
    case 'concern':
      rot = -0.35;
      dy = -0.004;
      break;
    case 'surprise':
      dy = 0.025;
      break;
    case 'sleepy':
      dy = -0.012;
      break;
    case 'laugh':
      dy = 0.02;
      rot = -0.15;
      break;
  }
  // left brow is at -x in face space (character's right). Inner ends tilt symmetrically.
  bl.rotation.z = -(rot + rig.browBase);
  br.rotation.z = rot + rig.browBase;
  bl.position.y = br.position.y = 0.075 + dy;
  rig.mouthSmile.visible = e === 'happy' || e === 'neutral' || e === 'curious' || e === 'laugh';
  rig.mouthSmile.scale.set(e === 'laugh' ? 1.3 : 1, e === 'happy' ? 1.3 : e === 'laugh' ? 1.8 : 0.7, 1);
  rig.mouthO.visible = e === 'surprise' || e === 'concern';
  rig.mouthFlat.visible = e === 'focus' || e === 'sleepy';
}

/** Open/close the mouth without touching brows (used while an agent is talking). */
export function setMouth(rig: Rig, open: boolean) {
  rig.mouthO.visible = open;
  rig.mouthSmile.visible = !open;
  rig.mouthFlat.visible = false;
}
