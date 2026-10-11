// Pose library. A pose is a set of joint rotations plus a vertical lift of the body.
// Helpers use intuitive units: "fwd" swings a limb forward, "flex" bends elbow/knee.
import { JOINTS, type JointName } from './character';

export interface Pose {
  r: Record<JointName, [number, number, number]>;
  lift: number;
}

export function blank(): Pose {
  const r = {} as Pose['r'];
  for (const j of JOINTS) r[j] = [0, 0, 0];
  return { r, lift: 0 };
}

export function copyPose(src: Pose, dst: Pose = blank()): Pose {
  for (const j of JOINTS) {
    dst.r[j][0] = src.r[j][0];
    dst.r[j][1] = src.r[j][1];
    dst.r[j][2] = src.r[j][2];
  }
  dst.lift = src.lift;
  return dst;
}

export function lerpPose(a: Pose, b: Pose, u: number, out: Pose = blank()): Pose {
  for (const j of JOINTS) for (let i = 0; i < 3; i++) out.r[j][i] = a.r[j][i] + (b.r[j][i] - a.r[j][i]) * u;
  out.lift = a.lift + (b.lift - a.lift) * u;
  return out;
}

export function arm(p: Pose, side: 'L' | 'R', fwd: number, out: number, flex: number, twist = 0) {
  const sh = p.r[side === 'L' ? 'shL' : 'shR'];
  const el = p.r[side === 'L' ? 'elL' : 'elR'];
  sh[0] = -fwd;
  sh[1] = side === 'L' ? twist : -twist;
  sh[2] = side === 'L' ? out : -out;
  el[0] = -flex;
}

export function leg(p: Pose, side: 'L' | 'R', fwd: number, flex: number, out = 0) {
  const hip = p.r[side === 'L' ? 'hipL' : 'hipR'];
  hip[0] = -fwd;
  hip[2] = side === 'L' ? out : -out;
  p.r[side === 'L' ? 'knL' : 'knR'][0] = flex;
}

export const TAU = Math.PI * 2;
export const ease = {
  inOutQuad: (u: number) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2),
  outCubic: (u: number) => 1 - Math.pow(1 - u, 3),
  outBack: (u: number) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(u - 1, 3) + c1 * Math.pow(u - 1, 2);
  },
  inOutSine: (u: number) => -(Math.cos(Math.PI * u) - 1) / 2,
};
export const clamp01 = (u: number) => (u < 0 ? 0 : u > 1 ? 1 : u);

/** Per-character random offsets so a room full of agents never moves in lockstep. */
export interface Quirks {
  seed: number; // 0..1
  glanceAt: number;
  glanceDir: number;
}

// ---------------------------------------------------------------------------- standing

export function standIdle(p: Pose, g: number, q: Quirks) {
  const b = Math.sin(TAU * 0.25 * g + q.seed * 6);
  p.lift = 0.008 * b;
  p.r.spine[0] = 0.03 * b;
  arm(p, 'L', 0.08, 0.12, 0.15);
  arm(p, 'R', 0.08, 0.12, 0.15);
  leg(p, 'L', 0, 0.02);
  leg(p, 'R', 0, 0.02);
  const shift = Math.sin(TAU * g / 6 + q.seed * 3);
  p.r.hips[2] = 0.04 * shift;
  p.r.spine[2] = -0.03 * shift;
  p.r.head[1] = 0.15 * Math.sin(0.3 * g + q.seed * 9) + glance(g, q) * 0.4;
  p.r.head[0] = 0.02;
}

function glance(g: number, q: Quirks) {
  // smooth bump of ~1.2s every 4-8s
  const period = 4 + q.seed * 4;
  const u = ((g + q.seed * 10) % period) / 1.2;
  if (u > 1) return 0;
  return Math.sin(Math.PI * u) * (q.seed > 0.5 ? 1 : -1);
}

export function walk(p: Pose, phase: number, q: Quirks) {
  const s = Math.sin(phase);
  leg(p, 'L', 0.55 * s, 0.1 + 0.9 * Math.max(0, -Math.sin(phase + 0.6)));
  leg(p, 'R', -0.55 * s, 0.1 + 0.9 * Math.max(0, Math.sin(phase + 0.6)));
  arm(p, 'L', -0.55 * s, 0.12, 0.3 + 0.25 * Math.max(0, -s));
  arm(p, 'R', 0.55 * s, 0.12, 0.3 + 0.25 * Math.max(0, s));
  p.lift = 0.045 * Math.pow(Math.abs(Math.cos(phase)), 0.7);
  p.r.spine[0] = 0.08;
  p.r.hips[1] = 0.06 * s;
  p.r.hips[2] = 0.05 * s;
  p.r.spine[1] = -0.05 * s;
  p.r.spine[2] = -0.04 * s;
  p.r.head[2] = 0.03 * s;
  p.r.head[0] = -0.02 + 0.04 * Math.cos(2 * phase + 0.4); // counter-bob
  p.r.head[1] = 0.05 * Math.sin(phase * 0.25 + q.seed * 5);
}

// ---------------------------------------------------------------------------- seated

export const DESK_LIFT = 0.23; // seat top 0.55
export const COUCH_LIFT = 0.1; // seat top 0.42

export function seatedBase(p: Pose, lift: number, g: number, q: Quirks) {
  p.lift = lift;
  const swing = Math.sin(TAU * 0.6 * g + q.seed * 7);
  // dangling feet, gently kicking
  leg(p, 'L', 1.5, 1.35 + 0.12 * swing, 0.06);
  leg(p, 'R', 1.5, 1.35 - 0.12 * swing, 0.06);
  p.r.spine[0] = 0.06 + 0.015 * Math.sin(TAU * 0.25 * g);
}

export function typing(p: Pose, g: number, q: Quirks, intensity: number) {
  seatedBase(p, DESK_LIFT, g, q);
  const f = 5 + 3 * intensity;
  const a = 0.06 + 0.07 * intensity;
  p.r.spine[0] = 0.16;
  arm(p, 'L', 0.55 + a * 0.4 * Math.sin(TAU * f * g + 1), 0.16, 1.0 + a * Math.sin(TAU * f * g));
  arm(p, 'R', 0.55 + a * 0.4 * Math.sin(TAU * f * g + 2.6), 0.16, 1.0 + a * Math.sin(TAU * f * g + 2.1));
  p.r.head[0] = 0.1 + 0.03 * Math.sin(TAU * 0.5 * g);
  p.r.head[1] = 0.05 * Math.sin(1.3 * g + q.seed) + glance(g * 0.8, q) * 0.45;
}

export function thinking(p: Pose, g: number, q: Quirks) {
  seatedBase(p, DESK_LIFT, g, q);
  p.r.spine[0] = 0.12;
  arm(p, 'L', 0.55, 0.16, 1.0);
  arm(p, 'R', 0.75, -0.15, 2.45); // hand to chin
  p.r.head[0] = -0.08 + 0.04 * Math.sin(TAU * 0.4 * g);
  p.r.head[1] = 0.22 + 0.05 * Math.sin(0.7 * g + q.seed);
  p.r.head[2] = 0.12;
}

export function reading(p: Pose, g: number, q: Quirks) {
  seatedBase(p, DESK_LIFT, g, q);
  p.r.spine[0] = 0.3;
  arm(p, 'L', 0.62, 0.18, 1.1);
  arm(p, 'R', 0.62, 0.18, 1.1 + 0.05 * Math.sin(TAU * 0.4 * g)); // scrolling the mouse wheel
  const nod = ((g + q.seed * 3) % 2.5) < 0.25 ? 0.08 : 0;
  p.r.head[0] = 0.22 + nod;
  p.r.head[1] = 0.12 * Math.sin(TAU * 0.3 * g);
}

export function running(p: Pose, g: number, q: Quirks) {
  seatedBase(p, DESK_LIFT, g, q);
  p.r.spine[0] = -0.12;
  arm(p, 'L', 0.55, -0.4, 2.0, 0.6); // arms crossed
  arm(p, 'R', 0.45, -0.45, 2.1, 0.6);
  p.r.head[0] = 0.04 + 0.02 * Math.sin(TAU * 0.3 * g);
  p.r.head[1] = 0.04 * Math.sin(0.9 * g + q.seed);
  // foot tap
  p.r.knR[0] = 1.2 + 0.28 * Math.max(0, Math.sin(TAU * 2.5 * g));
}

export function searching(p: Pose, g: number, q: Quirks) {
  typing(p, g, q, 0.6);
  p.r.head[1] = 0.3 * Math.sin(TAU * 0.8 * g);
  p.r.head[0] = 0.06;
}

export function delegating(p: Pose, g: number, q: Quirks) {
  seatedBase(p, DESK_LIFT, g, q);
  // swivels toward the room and points, "you, take this one!"
  p.r.spine[1] = 0.35;
  p.r.spine[0] = 0.02;
  arm(p, 'L', 0.55, 0.16, 1.0);
  arm(p, 'R', 1.45 + 0.08 * Math.sin(TAU * 1.5 * g), -0.5, 0.25);
  p.r.head[1] = 0.5;
  p.r.head[0] = -0.05;
}

export function raiseHand(p: Pose, g: number) {
  arm(p, 'R', 2.85, -0.15 + 0.15 * Math.sin(TAU * 1.5 * g), 0.2);
  p.r.head[0] = -0.15;
  p.r.head[1] *= 0.3;
}

export function couch(p: Pose, g: number, q: Quirks, prop: 'mug' | 'phone') {
  seatedBase(p, COUCH_LIFT, g, q);
  leg(p, 'L', 1.45, 1.4, 0.08);
  leg(p, 'R', 1.45, 1.4, 0.08);
  p.r.spine[0] = -0.12; // lounging back
  if (prop === 'phone') {
    arm(p, 'L', 0.65, 0.15, 1.8);
    arm(p, 'R', 0.55, -0.05, 1.7 + 0.05 * Math.sin(TAU * 4 * g));
    p.r.head[0] = 0.35;
    p.r.head[1] = 0.05 * Math.sin(0.5 * g);
  } else {
    // mug rests on lap, a sip every ~10s
    const period = 8 + q.seed * 6;
    const u = ((g + q.seed * 20) % period) / 2.4;
    const sip = u < 1 ? Math.sin(Math.PI * clamp01(u)) : 0;
    arm(p, 'L', 0.3, 0.2, 0.5);
    arm(p, 'R', 0.6 + 0.9 * sip, -0.05, 1.3 + 1.1 * sip);
    p.r.head[0] = -0.05 - 0.15 * sip;
    p.r.head[1] = (1 - sip) * (0.25 * Math.sin(0.25 * g + q.seed * 4));
  }
}

export function celebrate(p: Pose, t: number) {
  // 0-0.3 crouch, 0.3-0.9 jump, 0.9-1.3 land, 1.3-2.2 fist pump
  standIdle(p, t, { seed: 0, glanceAt: 0, glanceDir: 0 });
  if (t < 0.3) {
    const u = ease.inOutQuad(t / 0.3);
    leg(p, 'L', 0.5 * u, 0.9 * u);
    leg(p, 'R', 0.5 * u, 0.9 * u);
    p.r.spine[0] = 0.25 * u;
    p.lift = -0.09 * u;
    arm(p, 'L', -0.4 * u, 0.2, 0.3);
    arm(p, 'R', -0.4 * u, 0.2, 0.3);
  } else if (t < 0.9) {
    const u = (t - 0.3) / 0.6;
    p.lift = 0.42 * Math.sin(Math.PI * u);
    leg(p, 'L', 0.2, 0.6 * Math.sin(Math.PI * u));
    leg(p, 'R', 0.2, 0.6 * Math.sin(Math.PI * u));
    arm(p, 'L', 3.0, 0.4, 0.1);
    arm(p, 'R', 3.0, 0.4, 0.1);
    p.r.head[0] = -0.2;
  } else if (t < 1.3) {
    const u = (t - 0.9) / 0.4;
    const k = Math.sin(Math.PI * u);
    leg(p, 'L', 0.4 * k, 0.8 * k);
    leg(p, 'R', 0.4 * k, 0.8 * k);
    p.lift = -0.07 * k;
    arm(p, 'L', 2.8, 0.4, 0.2);
    arm(p, 'R', 2.8, 0.4, 0.2);
  } else {
    const pump = Math.sin(TAU * 3 * t);
    arm(p, 'R', 2.6 + 0.3 * pump, 0.2, 1.4 + 0.4 * pump);
    arm(p, 'L', 0.2, 0.25, 1.4);
    p.r.head[0] = -0.15;
    p.lift = 0.02 * Math.abs(pump);
  }
}

/** Celebration B: hip-wiggle dance. */
export function dance(p: Pose, t: number) {
  standIdle(p, t, { seed: 0.2, glanceAt: 0, glanceDir: 0 });
  const w = Math.sin(TAU * 2 * t);
  p.r.hips[1] = 0.25 * w;
  p.r.spine[1] = -0.15 * w;
  arm(p, 'L', 1.6 + 0.4 * Math.sin(4 * Math.PI * t), 0.5, 1.2);
  arm(p, 'R', 1.6 + 0.4 * Math.sin(4 * Math.PI * t + Math.PI), 0.5, 1.2);
  leg(p, 'L', 0.1, 0.25 + 0.2 * Math.max(0, w));
  leg(p, 'R', 0.1, 0.25 + 0.2 * Math.max(0, -w));
  p.lift = 0.02 * Math.abs(Math.sin(TAU * 4 * t)) - 0.03;
  p.r.head[2] = 0.1 * Math.sin(TAU * 2 * t + 1);
}

/** Celebration C: jump with a full spin, then a double fist pump. */
export function spinPump(p: Pose, t: number) {
  celebrate(p, t);
  if (t >= 0.3 && t < 0.9) {
    arm(p, 'R', 3.0, 0.3, 0.2);
    arm(p, 'L', 0.6, 0.6, 0.6);
  } else if (t >= 1.2) {
    const k = 0.3 * Math.sin(TAU * 3 * t);
    arm(p, 'L', 2.5 + k, 0.3, 1.3);
    arm(p, 'R', 2.5 - k, 0.3, 1.3);
  }
}

export function spinPumpYaw(t: number) {
  return t < 0.3 ? 0 : t < 0.9 ? TAU * ease.outCubic((t - 0.3) / 0.6) : 0;
}

export function stretch(p: Pose, t: number) {
  standIdle(p, t, { seed: 0.3, glanceAt: 0, glanceDir: 0 });
  const u = t < 0.5 ? ease.inOutQuad(t / 0.5) : t > 1.2 ? 1 - ease.inOutQuad(clamp01((t - 1.2) / 0.4)) : 1;
  const tremble = 0.02 * Math.sin(TAU * 9 * t) * u;
  arm(p, 'L', 3.0 * u, 0.15, 0.3 * u + tremble);
  arm(p, 'R', 3.0 * u, 0.15, 0.3 * u - tremble);
  p.r.spine[0] = -0.15 * u;
  p.r.head[0] = -0.3 * u;
  p.lift = 0.02 * u;
}

export function whiteboard(p: Pose, g: number, q: Quirks) {
  standIdle(p, g, q);
  arm(p, 'R', 1.6, -0.1, 0.4 + 0.15 * Math.sin(TAU * 1.2 * g)); // writing
  arm(p, 'L', 0.3, 0.2, 1.4);
  p.r.head[0] = -0.1;
  p.r.head[1] = 0.1 * Math.sin(TAU * 0.6 * g);
}
