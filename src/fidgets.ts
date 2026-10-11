// Idle fidgets layered on top of the working / lounging pose now and then.
import type { Expression } from './character';
import type { ActivityKind } from './types';
import * as P from './pose';

export interface Fidget {
  name: string;
  dur: number;
  emote?: import('./emotes').EmoteKind;
  when?: (kind?: ActivityKind) => boolean;
  pose: (p: P.Pose, t: number, g: number) => Expression | void;
  spin?: (t: number) => number;
}

const bump = (t: number, a: number, b: number) => (t < a || t > b ? 0 : Math.sin(((t - a) / (b - a)) * Math.PI));

export const FIDGETS_DESK: Fidget[] = [
  {
    name: 'scratch-head',
    dur: 1.8,
    emote: 'question',
    when: (k) => k === 'think' || k === 'search' || k === 'read',
    pose: (p, t) => {
      P.arm(p, 'R', 2.5, -0.35, 2.3 + 0.18 * Math.sin(t * 22));
      p.r.head[2] = -0.15;
      p.r.head[0] = -0.05;
      return 'curious';
    },
  },
  {
    name: 'sip-mug',
    dur: 2.4,
    pose: (p, t) => {
      const s = bump(t, 0.2, 2.2);
      P.arm(p, 'R', 0.6 + 0.6 * s, 0.1 - 0.2 * s, 1.2 + 1.1 * s);
      p.r.head[0] = 0.1 - 0.25 * s;
      p.r.spine[0] = 0.05;
      return 'happy';
    },
  },
  {
    name: 'crack-knuckles',
    dur: 1.6,
    when: (k) => k === 'write' || k === 'todo' || k === 'other',
    pose: (p, t) => {
      const push = t < 0.5 ? P.ease.outCubic(t / 0.5) : 1;
      P.arm(p, 'L', 1.5 * push, -0.35, 0.3, 0.3);
      P.arm(p, 'R', 1.5 * push, -0.35, 0.3, 0.3);
      p.r.spine[0] = 0.0;
      p.lift += 0.01 * Math.max(0, Math.sin(t * 30)) * (t > 0.6 && t < 1.2 ? 1 : 0);
      return 'happy';
    },
  },
  {
    name: 'chair-swivel',
    dur: 1.4,
    spin: (t) => 0.35 * Math.sin(Math.PI * (t / 1.4)),
    pose: (p) => {
      P.leg(p, 'L', 1.3, 1.0);
      P.leg(p, 'R', 1.3, 1.0);
      p.r.spine[0] = 0.0;
      return 'happy';
    },
  },
  {
    name: 'neck-stretch',
    dur: 2.0,
    pose: (p, t) => {
      p.r.head[2] = 0.4 * Math.sin((t / 2) * Math.PI * 2);
      p.r.head[0] = -0.1;
      return 'sleepy';
    },
  },
  {
    name: 'hands-behind-head',
    dur: 3.2,
    emote: 'music',
    when: (k) => k === 'run',
    pose: (p, t) => {
      P.arm(p, 'L', 2.7, 0.75, 2.5);
      P.arm(p, 'R', 2.7, 0.75, 2.5);
      p.r.spine[0] = -0.25;
      p.r.head[0] = -0.2;
      p.r.head[1] = 0.15 * Math.sin(t * 3);
      return 'happy';
    },
  },
];

export const FIDGETS_COUCH: Fidget[] = [
  {
    name: 'yawn',
    dur: 2.4,
    pose: (p, t) => {
      const s = bump(t, 0.1, 2.2);
      P.arm(p, 'L', 2.6 * s, 0.4, 0.3);
      P.arm(p, 'R', 2.6 * s, 0.4, 0.3);
      p.r.head[0] = -0.35 * s;
      p.r.spine[0] = -0.2 * s;
      return s > 0.3 ? 'surprise' : 'sleepy';
    },
  },
  {
    name: 'doze',
    dur: 5,
    emote: 'zzz',
    pose: (p, t) => {
      const nod = 0.35 + 0.08 * Math.sin(t * 1.4);
      p.r.head[0] = nod;
      p.r.head[2] = 0.2;
      p.r.spine[0] = -0.05;
      return 'sleepy';
    },
  },
];
