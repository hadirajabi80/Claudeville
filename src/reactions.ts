// Tease and mood reactions, choreographed per the Fable design spec.
// Each one is a cosmetic overlay: it edits the agent's current pose for a moment and never touches live state.
import * as THREE from 'three';
import type { Agent, Reaction } from './agent';
import * as P from './pose';

type R = Omit<Reaction, 't'>;
const TAU = Math.PI * 2;
let camPos = new THREE.Vector3(0, 8, 10);

export function setCamera(p: THREE.Vector3) {
  camPos = p;
}

function shortest(a: number, b: number) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** Head yaw (relative to the body) that looks at the camera, clamped. */
function toCam(a: Agent, clamp = 0.6) {
  const p = a.position;
  const want = Math.atan2(camPos.x - p.x, camPos.z - p.z);
  return THREE.MathUtils.clamp(shortest(a.yawAngle, want), -clamp, clamp);
}
function toPoint(a: Agent, pt: THREE.Vector3, clamp = 0.8) {
  const p = a.position;
  return THREE.MathUtils.clamp(shortest(a.yawAngle, Math.atan2(pt.x - p.x, pt.z - p.z)), -clamp, clamp);
}
const seg = (t: number, a: number, b: number) => P.clamp01((t - a) / (b - a));

/** Arms crossed, glaring at the camera. */
function crossArms(p: P.Pose) {
  P.arm(p, 'L', 0.55, -0.4, 2.0, 0.6);
  P.arm(p, 'R', 0.45, -0.45, 2.1, 0.6);
}

/** When the agent is not seated, give the reaction a standing body. */
function standBase(p: P.Pose, g: number, a: Agent, seated: boolean) {
  if (!seated) P.standIdle(p, g, a.quirks);
}

// --------------------------------------------------------------------------- A1 poke

export function poked(a: Agent): R {
  return {
    name: 'poke',
    dur: 0.7,
    hold: true,
    pose: (p, t, g, seated) => {
      standBase(p, g, a, seated);
      const k = t < 0.08 ? t / 0.08 : t < 0.35 ? 1 : 1 - (t - 0.35) / 0.35;
      p.r.spine[0] += -0.12 * k - 0.1 * k;
      p.r.spine[2] = 0.06 * Math.sin(TAU * 8 * t) * Math.exp(-6 * t);
      p.r.head[0] += -0.15 * k;
      p.lift += 0.02 * k;
      if (k > 0.3) {
        P.arm(p, 'L', 0.3, 0.5, 0.6);
        P.arm(p, 'R', 0.3, 0.5, 0.6);
      }
      if (t < 0.02) a.kick(-0.08);
      return 'surprise';
    },
  };
}

export function annoyed(a: Agent): R {
  return {
    name: 'annoyed',
    dur: 1.3,
    hold: true,
    pose: (p, t, g, seated) => {
      standBase(p, g, a, seated);
      crossArms(p);
      p.r.spine[0] = seated ? 0.02 : -0.08;
      p.r.head[1] = toCam(a);
      p.r.head[0] = 0.05;
      // little foot stomp when standing
      if (!seated && t > 0.2 && t < 0.6) P.leg(p, 'R', 0.2 * Math.max(0, Math.sin(TAU * 4 * t)), 0.3 * Math.max(0, Math.sin(TAU * 4 * t)));
      return 'concern';
    },
  };
}

// --------------------------------------------------------------------------- A2 tickle

export function tickle(): R {
  return {
    name: 'tickle',
    dur: 1.4,
    hold: true,
    pose: (p, t) => {
      const w = Math.sin(TAU * 6 * t);
      p.r.spine[2] = 0.1 * w;
      p.r.spine[0] = -0.1;
      p.r.head[0] = 0.1;
      p.r.head[2] = 0.08 * Math.sin(TAU * 6 * t + Math.PI);
      const j = 0.1 * Math.sin(TAU * 8 * t);
      P.arm(p, 'L', 0.4 + j, -0.35, 1.9);
      P.arm(p, 'R', 0.4 - j, -0.35, 1.9);
      p.lift += 0.015 * Math.abs(Math.sin(TAU * 12 * t));
      return 'laugh';
    },
  };
}

// --------------------------------------------------------------------------- A3 paper ball

export function bonked(a: Agent): R {
  const side = Math.random() < 0.5 ? -1 : 1;
  return {
    name: 'bonk',
    dur: 1.6,
    hold: true,
    pose: (p, t, g, seated) => {
      standBase(p, g, a, seated);
      if (t < 0.02) a.kick(0.1);
      if (t < 0.5) {
        const k = Math.min(1, t / 0.1);
        p.r.head[0] += 0.25 * k;
        p.r.head[2] = side * 0.15 * k;
        p.r.spine[0] += 0.08 * k;
        return 'surprise';
      }
      // rub the sore spot and glare
      P.arm(p, 'R', 2.6, 0.35, 2.3 + 0.08 * Math.sin(TAU * 4 * t));
      p.r.head[1] = toCam(a);
      p.r.head[2] = side * 0.08;
      return 'concern';
    },
  };
}

export function duckHit(a: Agent): R {
  return {
    name: 'duck',
    dur: 1.6,
    hold: true,
    pose: (p, t, g, seated) => {
      standBase(p, g, a, seated);
      P.arm(p, 'L', 0.95, -0.3, 2.0);
      P.arm(p, 'R', 0.95, -0.3, 2.0);
      p.r.head[2] = 0.18 * Math.sin(TAU * 1.2 * t);
      p.r.head[0] = 0.08;
      p.r.spine[1] = 0.12 * Math.sin(TAU * 1.2 * t);
      return 'happy';
    },
  };
}

/** Quick curious glance at something (a duck that landed nearby, a ball that missed). */
export function look(a: Agent, pt: THREE.Vector3): R {
  const yaw = toPoint(a, pt);
  return {
    name: 'look',
    dur: 0.9,
    hold: false,
    pose: (p) => {
      p.r.head[1] = yaw;
      p.r.head[0] += 0.1;
      p.r.spine[1] += 0.1 * Math.sign(yaw);
      return 'curious';
    },
  };
}

// --------------------------------------------------------------------------- A4 dropped

export function landed(a: Agent): R {
  return {
    name: 'landed',
    dur: 1.4,
    hold: true,
    pose: (p, t, g) => {
      P.standIdle(p, g, a.quirks);
      p.r.head[2] = 0.12 * Math.sin(TAU * 3 * t) * Math.exp(-2 * t);
      p.r.spine[2] = 0.08 * Math.sin(TAU * 3 * t + 1) * Math.exp(-2 * t);
      if (t > 0.6) {
        // dust off
        P.arm(p, 'R', 0.9, -0.4, 1.0 + 0.3 * Math.sin(TAU * 4 * t));
        p.r.head[1] = toCam(a);
      }
      return 'concern';
    },
  };
}

// --------------------------------------------------------------------------- water

export function wet(a: Agent): R {
  return {
    name: 'wet',
    dur: 1.2,
    hold: true,
    pose: (p, t, g, seated) => {
      standBase(p, g, a, seated);
      p.r.spine[2] = 0.05 * Math.sin(TAU * 14 * t);
      p.r.spine[0] += 0.05;
      P.arm(p, 'L', 0.5, -0.4, 2.0 + 0.1 * Math.sin(TAU * 14 * t));
      P.arm(p, 'R', 0.5, -0.4, 2.0 - 0.1 * Math.sin(TAU * 14 * t));
      p.r.head[0] = 0.15;
      p.r.head[1] = 0.25 * Math.sin(TAU * 2 * t);
      return 'concern';
    },
  };
}

// --------------------------------------------------------------------------- A5 monitor off

export function monitorPanic(a: Agent): R {
  return {
    name: 'monitor',
    dur: 2.6,
    hold: true,
    pose: (p, t) => {
      if (t < 0.15) {
        p.r.spine[0] = -0.05;
        p.r.head[0] = -0.1;
        return 'surprise';
      }
      if (t < 2.1) {
        p.r.spine[0] = 0.35;
        p.r.head[0] = 0.15;
        P.arm(p, 'R', 1.5, 0.05, 0.3 + 0.25 * Math.max(0, Math.sin(TAU * 5 * t))); // tap tap tap
        P.arm(p, 'L', 0.9, 0.1, 1.2);
        if (t > 1.2) P.arm(p, 'L', 1.4, 0.3, 0.4); // two hands now
        return t > 1.3 ? 'concern' : 'surprise';
      }
      p.r.head[0] = -0.05 + 0.08 * Math.sin(TAU * 2 * t);
      P.arm(p, 'L', 0.55, 0.16, 1.0);
      P.arm(p, 'R', 0.55, 0.16, 1.0);
      return 'happy';
    },
  };
}

// --------------------------------------------------------------------------- A6 spin chair

export function spinChair(a: Agent, turns = 2): R {
  return {
    name: 'spin',
    dur: 2.6,
    hold: true,
    spin: (t) => (t < 1.6 ? TAU * turns * P.ease.outCubic(t / 1.6) : 0),
    pose: (p, t) => {
      if (t < 1.6) {
        P.arm(p, 'L', 0.9, 0.9, 0.3);
        P.arm(p, 'R', 0.9, 0.9, 0.3);
        P.leg(p, 'L', 1.2, 0.4, 0.2);
        P.leg(p, 'R', 1.2, 0.4, 0.2);
        p.r.head[2] = 0.1;
        p.r.spine[0] = -0.1;
        return 'laugh';
      }
      p.r.head[2] = 0.14 * Math.sin(TAU * 3 * t);
      p.r.spine[2] = 0.06 * Math.sin(TAU * 3 * t + 1);
      return 'surprise';
    },
  };
}

// --------------------------------------------------------------------------- A7 steal mug

export function mugStolen(a: Agent, mugPos: THREE.Vector3): R {
  return {
    name: 'mug',
    dur: 4.5,
    hold: true,
    pose: (p, t) => {
      if (t < 0.4) return;
      if (t < 1.4) {
        p.r.head[1] = toPoint(a, mugPos);
        p.r.head[0] = 0.2;
        if (t > 0.7) P.arm(p, 'L', 1.0, 0.5, 0.6 + 0.15 * Math.sin(TAU * 3 * t)); // pat the desk
        return 'curious';
      }
      if (t < 4.0) {
        p.r.head[1] = toCam(a);
        crossArms(p);
        return 'concern';
      }
      p.r.head[0] = 0.1 * Math.sin(TAU * 2 * (t - 4));
      return 'happy';
    },
  };
}

// --------------------------------------------------------------------------- A9 pull chair

export function chairFall(a: Agent): R {
  return {
    name: 'chair',
    dur: 2.4,
    hold: true,
    pose: (p, t, g) => {
      const floor = -0.3;
      if (t < 0.25) {
        const u = (t / 0.25) ** 2;
        p.lift = P.DESK_LIFT + (floor - P.DESK_LIFT) * u;
        P.leg(p, 'L', 1.3, 0.4, 0.3);
        P.leg(p, 'R', 1.3, 0.4, 0.3);
        P.arm(p, 'L', -0.6, 0.5, 0.3);
        P.arm(p, 'R', -0.6, 0.5, 0.3);
        p.r.spine[0] = -0.3;
        return 'surprise';
      }
      if (t < 0.28) a.kick(0.18);
      if (t < 1.4) {
        p.lift = floor;
        P.leg(p, 'L', 1.45, 0.15 + 0.1 * Math.sin(g * 3), 0.25);
        P.leg(p, 'R', 1.45, 0.15, 0.25);
        P.arm(p, 'L', -0.5, 0.35, 0.2);
        P.arm(p, 'R', -0.5, 0.35, 0.2);
        p.r.spine[0] = -0.2;
        p.r.head[1] = t > 0.6 ? toCam(a) : 0.3 * Math.sin(TAU * 1.5 * t);
        return 'concern';
      }
      // hop back up into the returned chair
      const u = seg(t, 1.4, 2.2);
      p.lift = floor + (P.DESK_LIFT - floor) * P.ease.outCubic(u) + 0.3 * Math.sin(Math.PI * u);
      if (u >= 1 && t < 2.25) a.kick(0.08);
      return 'concern';
    },
  };
}

// --------------------------------------------------------------------------- retaliation

export function retaliate(a: Agent): R {
  return {
    name: 'retaliate',
    dur: 1.25,
    hold: true,
    spin: (t) => {
      const want = toCam(a, Math.PI);
      const k = t < 0.3 ? P.ease.outCubic(t / 0.3) : t > 1.0 ? 1 - seg(t, 1.0, 1.25) : 1;
      return want * k * 0.8;
    },
    pose: (p, t, g, seated) => {
      standBase(p, g, a, seated);
      if (t < 0.3) {
        crossArms(p);
        return 'concern';
      }
      if (t < 0.6) {
        P.arm(p, 'R', 2.6, 0.2, 1.6); // wind-up
        p.r.spine[1] = -0.3;
        p.r.spine[0] = -0.1;
        return 'concern';
      }
      P.arm(p, 'R', 1.2, 0.1, 0.2); // release
      p.r.spine[1] = 0.2;
      p.r.spine[0] = 0.15;
      return 'happy';
    },
  };
}

// --------------------------------------------------------------------------- moods from the live session

export function facepalm(): R {
  if (Math.random() < 0.4) {
    return {
      name: 'headdesk',
      dur: 2.0,
      hold: false,
      pose: (p, t) => {
        const k = t < 0.25 ? t / 0.25 : 1;
        p.r.spine[0] = 0.75 * k;
        p.r.head[0] = 0.3 * k;
        P.arm(p, 'L', 1.4, 0.2, 0.6);
        P.arm(p, 'R', 1.4, 0.2, 0.6);
        p.r.head[1] = 0.1 * Math.sin(TAU * 1.5 * t); // slow head roll of despair
        return 'sleepy';
      },
    };
  }
  return {
    name: 'facepalm',
    dur: 1.6,
    hold: false,
    pose: (p) => {
      P.arm(p, 'R', 2.4, 0.15, 2.5);
      p.r.head[0] = 0.25;
      p.r.spine[0] = 0.1 + (p.r.spine[0] ?? 0) * 0.5;
      return 'concern';
    },
  };
}

export function lightbulb(): R {
  return {
    name: 'bulb',
    dur: 1.4,
    hold: false,
    pose: (p, t) => {
      const k = Math.min(1, t / 0.12);
      p.r.head[0] = -0.2 * k;
      p.r.spine[0] = -0.1 * k;
      p.lift += 0.02 * k;
      if (t < 0.7) P.arm(p, 'R', 2.0, 0.1, 1.2); // index finger up: "aha!"
      return 'happy';
    },
  };
}

// --------------------------------------------------------------------------- greeting the player

/** Turn toward the player and wave (one hand if seated and busy). */
export function waveBack(a: Agent, who: THREE.Vector3): R {
  const yaw = toPoint(a, who, 0.9);
  return {
    name: 'wave',
    dur: 1.6,
    hold: !a.seated,
    pose: (p, t, g, seated) => {
      standBase(p, g, a, seated);
      p.r.head[1] = yaw;
      p.r.spine[1] += yaw * 0.3;
      const k = Math.min(1, t / 0.2, (1.6 - t) / 0.3);
      P.arm(p, 'R', 2.7 * k + 0.5 * (1 - k), -0.35 + 0.35 * Math.sin(TAU * 2.2 * t), 0.5);
      return 'happy';
    },
  };
}

export function highFive(a: Agent, who: THREE.Vector3): R {
  const yaw = toPoint(a, who, Math.PI);
  return {
    name: 'highfive',
    dur: 1.3,
    hold: true,
    spin: (t) => yaw * Math.min(1, t / 0.2, Math.max(0, (1.3 - t) / 0.3)),
    pose: (p, t, g) => {
      P.standIdle(p, g, a.quirks);
      if (t < 0.3) P.arm(p, 'R', 2.4 * (t / 0.3), -0.2, 0.6);
      else if (t < 0.45) {
        P.arm(p, 'R', 2.2, -0.15, 0.15); // slap!
        if (t < 0.32) a.kick(0.1);
      } else {
        const pump = Math.sin(TAU * 3 * t);
        P.arm(p, 'R', 2.6 + 0.2 * pump, 0.2, 1.2);
        p.lift = 0.02 * Math.abs(pump);
      }
      return 'laugh';
    },
  };
}


// --------------------------------------------------------------------------- bumped / nod

/** Gentle lean away when the player walks into a standing agent. */
export function nudged(a: Agent, from: THREE.Vector3): R {
  const yaw = toPoint(a, from, Math.PI);
  const side = Math.sign(yaw) || 1;
  return {
    name: 'nudge',
    dur: 0.6,
    hold: true,
    pose: (p, t, g, seated) => {
      standBase(p, g, a, seated);
      const k = Math.sin(Math.PI * Math.min(1, t / 0.6));
      p.r.spine[0] -= 0.15 * k;
      p.r.hips[2] = -0.06 * side * k;
      p.r.head[1] = yaw * 0.6;
      return 'surprise';
    },
  };
}

/** Busy agents just nod hello without leaving their keyboard. */
export function nod(a: Agent, who: THREE.Vector3): R {
  const yaw = toPoint(a, who, 0.7);
  return {
    name: 'nod',
    dur: 0.9,
    hold: false,
    pose: (p, t) => {
      p.r.head[1] = yaw * Math.min(1, t / 0.2);
      p.r.head[0] += t > 0.25 && t < 0.65 ? 0.15 * Math.sin(((t - 0.25) / 0.4) * Math.PI) : 0;
      return 'happy';
    },
  };
}

// --------------------------------------------------------------------------- chatting with the user

type Who = () => THREE.Vector3;

/** Listening: turn the head (and partly the chair) toward whoever is talking, keep working otherwise. */
export function chatListen(a: Agent, who: Who): R {
  return {
    name: 'chat-listen',
    dur: 1e9,
    hold: false,
    spin: a.seated ? undefined : (t) => toPoint(a, who(), Math.PI) * Math.min(1, t / 0.3),
    pose: (p, _t, g, seated) => {
      const yaw = toPoint(a, who(), 0.9);
      if (!seated) {
        P.standIdle(p, g, a.quirks);
        p.r.head[1] = 0;
      } else {
        p.r.head[1] = yaw;
        p.r.spine[1] += yaw * 0.35;
      }
      p.r.head[0] -= 0.05;
      return 'curious';
    },
  };
}

/** Thinking about the answer: hand to chin, slow nod. */
export function chatThink(a: Agent, who: Who): R {
  return {
    name: 'chat-think',
    dur: 1e9,
    hold: false,
    spin: a.seated ? undefined : () => toPoint(a, who(), Math.PI),
    pose: (p, t, g, seated) => {
      const yaw = seated ? toPoint(a, who(), 0.9) : 0;
      if (!seated) P.standIdle(p, g, a.quirks);
      else p.r.spine[1] += yaw * 0.35;
      P.arm(p, 'R', 0.75, -0.15, 2.45);
      p.r.head[0] = -0.06 + 0.03 * Math.sin(TAU * 0.4 * t);
      p.r.head[2] = 0.1 * (Math.sign(yaw) || 1);
      p.r.head[1] = yaw * 0.8;
      return 'curious';
    },
  };
}

/** Talking: head bobs, hands gesture, mouth flaps until `dur` is nearly over. */
export function chatTalk(a: Agent, who: Who, dur: number, setMouth: (open: boolean) => void): R {
  let next = 0;
  let open = false;
  return {
    name: 'chat-talk',
    dur,
    hold: false,
    spin: a.seated ? undefined : () => toPoint(a, who(), Math.PI),
    pose: (p, t, g, seated) => {
      const yaw = seated ? toPoint(a, who(), 0.9) : 0;
      if (!seated) P.standIdle(p, g, a.quirks);
      else p.r.spine[1] += yaw * 0.35;
      p.r.head[0] += 0.06 * Math.sin(TAU * 2.2 * t);
      p.r.head[1] = yaw + 0.05 * Math.sin(TAU * 0.9 * t);
      p.r.spine[0] -= 0.04;
      P.arm(p, 'R', 0.9 + 0.25 * Math.sin(TAU * 1.3 * t), -0.2 + 0.15 * Math.sin(TAU * 0.7 * t), 1.6);
      if (!seated) P.arm(p, 'L', 0.9 + 0.25 * Math.sin(TAU * 1.3 * t + Math.PI), -0.2, 1.6);
      if (t < dur - 0.4) {
        if (t >= next) {
          open = !open;
          next = t + 0.09 + Math.random() * 0.07;
          setMouth(open);
        }
      } else if (open) {
        open = false;
        setMouth(false);
      }
      return 'happy';
    },
  };
}


// --------------------------------------------------------------------------- slap & smack

/** Slap across the face: head snaps sideways, wobbles, then a hand goes to the sore cheek. */
export function slapped(a: Agent): R {
  const side = Math.random() < 0.5 ? -1 : 1;
  return {
    name: 'slap',
    dur: 1.9,
    hold: true,
    pose: (p, t, g, seated) => {
      standBase(p, g, a, seated);
      if (t < 0.02) a.kick(0.12);
      const snap = t < 0.07 ? t / 0.07 : Math.exp(-(t - 0.07) * 3.5);
      const wob = Math.sin(TAU * 5 * t) * Math.exp(-t * 4);
      p.r.head[1] = side * (0.75 * snap + 0.12 * wob);
      p.r.head[2] = side * 0.28 * snap;
      p.r.spine[1] += side * 0.22 * snap;
      p.r.spine[2] = -side * 0.1 * snap;
      if (t > 0.55) {
        // hand on the cheek that got hit, glaring at you
        P.arm(p, side > 0 ? 'L' : 'R', 2.2, -0.25, 2.5);
        p.r.head[1] = side * 0.15 + toCam(a, 0.4) * 0.6;
        return 'concern';
      }
      return 'surprise';
    },
  };
}

/** Smack on the back of the head: nods forward hard, then rubs the back of the head. */
export function smacked(a: Agent): R {
  return {
    name: 'smack',
    dur: 1.7,
    hold: true,
    pose: (p, t, g, seated) => {
      standBase(p, g, a, seated);
      if (t < 0.02) a.kick(0.15);
      const hit = t < 0.06 ? t / 0.06 : Math.exp(-(t - 0.06) * 4);
      p.r.head[0] += 0.55 * hit;
      p.r.spine[0] += 0.22 * hit;
      p.lift -= 0.02 * hit;
      if (t > 0.45) {
        P.arm(p, 'R', 2.9, 0.35, 2.7 + 0.12 * Math.sin(TAU * 4 * t)); // rub rub
        p.r.head[0] = 0.08;
        p.r.head[1] = toCam(a, 0.5);
        return 'concern';
      }
      return 'surprise';
    },
  };
}
