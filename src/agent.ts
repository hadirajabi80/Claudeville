// One animated character: an action queue (walk, sit, work, celebrate…) driving a blended pose.
import * as THREE from 'three';
import { buildCharacter, setExpression, type Expression, type Rig, type Gender, JOINTS } from './character';
import * as P from './pose';
import type { Activity, Role } from './types';
import type { Spot } from './world';
import type { EmoteKind } from './emotes';
import { FIDGETS_DESK, FIDGETS_COUCH, type Fidget } from './fidgets';

const LOOK_TMP = new THREE.Vector3();

export type ActionKind = 'pop' | 'walk' | 'sit' | 'stand' | 'work' | 'rest' | 'celebrate' | 'stretch' | 'fade' | 'turn';

export interface Action {
  kind: ActionKind;
  t: number;
  dur: number; // Infinity for looping actions
  path?: THREE.Vector3[];
  spot?: Spot;
  from?: THREE.Vector3;
  to?: THREE.Vector3;
  fromYaw?: number;
  toYaw?: number;
  onStart?: () => void;
  onDone?: () => void;
  started?: boolean;
  variant?: number;
}

const WALK_SPEED = 1.4;
const STRIDE_HZ = 1.9;

/** A short cosmetic reaction layered over whatever the agent is doing (poke, bonk, tickle…). */
export interface Reaction {
  name: string;
  t: number;
  dur: number;
  /** Modify the base pose in place; return an expression to show. */
  pose: (p: P.Pose, t: number, g: number, seated: boolean) => Expression | void;
  /** Pause the action queue (walking stops, timers freeze) while the reaction plays. */
  hold: boolean;
  onDone?: () => void;
  onTick?: (t: number) => void;
  /** Extra body yaw (chair spin, turning to throw); cosmetic, never changes the real heading. */
  spin?: (t: number) => number;
}

export interface Bubble {
  text: string;
  until: number;
  tone: 'tool' | 'say' | 'alert' | 'think';
}

function shortestAngle(a: number, b: number) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export class Agent {
  readonly rig: Rig;
  readonly quirks: P.Quirks;
  name: string;
  subtitle: string;
  /** display label of the model, e.g. "Opus 5.5" */
  model = '';
  activity: Activity | null = null;
  bubble: Bubble | null = null;
  notifying = false;
  spot: Spot | null = null; // claimed spot (desk / couch / standing place)
  seated = false;
  removed = false;
  toolDoneAt = 0;
  bornAt = performance.now();
  onEvent?: (e: 'celebrate' | 'arrive-desk' | 'gone' | 'step') => void;

  private queue: Action[] = [];
  private cur: Action | null = null;
  private pose = P.blank();
  private target = P.blank();
  private tmpA = P.blank();
  private tmpB = P.blank();
  private yaw = 0;
  private phase = 0;
  private blinkAt = 1 + Math.random() * 3;
  private blinkT = -1;
  private opacity = 1;
  private scale = 1;
  private expression: Expression = 'neutral';
  private badgeSpin = 1;
  private antennaVel = 0;
  private antennaAng = 0;
  private lastYaw = 0;
  private stepSide = 0;
  private popT = 1;
  // --- tease / polish layers
  reaction: Reaction | null = null;
  private reactW = 0;
  private reactPose = P.blank();
  held = false;
  falling = false;
  private vy = 0;
  private heldVel = new THREE.Vector3();
  private lastHeld = new THREE.Vector3();
  private dangle = 0;
  private dangleV = 0;
  private squash = 0;
  private squashV = 0;
  lookAt: THREE.Vector3 | null = null;
  private lookYaw = 0;
  private lookPitch = 0;
  onLanded?: () => void;
  emote?: (kind: EmoteKind, dur?: number) => void;
  sound?: (kind: string) => void;
  fidget: { def: Fidget; t: number } | null = null;
  private fidgetAt = 6 + Math.random() * 8;
  private spinOffset = 0;
  /** When set, this callback poses the character instead of the action queue (used for the player). */
  drive?: (p: P.Pose, g: number) => Expression;
  activitySince = performance.now();
  private leanedThisRun = false;

  constructor(
    readonly id: string,
    readonly role: Role,
    variant: number,
    readonly session: string,
    name: string,
    subtitle: string,
    readonly gender: Gender = 'm',
    seedKey = id,
  ) {
    this.rig = buildCharacter(variant, seedKey, gender);
    this.name = name;
    this.subtitle = subtitle;
    this.quirks = { seed: Math.random(), glanceAt: 0, glanceDir: 1 };
    if (role === 'sub') this.scale = 0.92;
    this.rig.root.scale.setScalar(this.scale);
  }

  get position() {
    return this.rig.root.position;
  }
  get busyWorking() {
    return this.cur?.kind === 'work';
  }
  get state() {
    return this.cur?.kind ?? 'rest';
  }
  get walking() {
    return this.cur?.kind === 'walk';
  }

  place(pos: THREE.Vector3, yaw: number) {
    this.rig.root.position.copy(pos);
    this.yaw = yaw;
    this.rig.root.rotation.y = yaw;
  }

  /** Replace whatever the agent is doing with a new plan. The current walk is cut short. */
  plan(actions: Partial<Action>[]) {
    // finishing hooks of an interrupted sit/stand must still run (they claim/release spots)
    if (this.reaction && !this.held) this.endReaction();
    this.fidget = null;
    const pending = [this.cur, ...this.queue].filter(Boolean) as Action[];
    for (const a of pending) if (a.kind === 'stand' && a.onDone) a.onDone();
    this.queue = actions.map(prep);
    this.cur = null;
    this.next();
  }

  enqueue(actions: Partial<Action>[]) {
    this.queue.push(...actions.map(prep));
    if (!this.cur || this.cur.dur === Infinity) this.next();
  }

  private next() {
    this.cur = this.queue.shift() ?? null;
    if (!this.cur) return;
    const a = this.cur;
    a.t = 0;
    if (a.kind === 'walk') this.seated = false;
    if (a.kind === 'sit') {
      a.from = this.position.clone();
      a.fromYaw = this.yaw;
    }
    if (a.kind === 'stand') {
      a.from = this.position.clone();
      a.fromYaw = this.yaw;
    }
    if (a.kind === 'turn') a.fromYaw = this.yaw;
    if (a.kind === 'celebrate' && a.variant === undefined) {
      const r = Math.random();
      a.variant = r < 0.4 ? 0 : r < 0.7 ? 1 : 2;
    }
  }

  popIn() {
    this.popT = 0;
    this.rig.root.scale.setScalar(0.001);
  }

  onSay?: (text: string, tone: Bubble['tone']) => void;
  /** Silence the babble voice while a real text-to-speech voice is talking. */
  muteBabble = false;
  /** A question or permission prompt this agent is waiting on you to answer. */
  pendingAsk: import('./types').AskPayload | null = null;

  say(text: string, tone: Bubble['tone'] = 'say', seconds = 4) {
    this.bubble = { text, tone, until: performance.now() + seconds * 1000 };
    this.onSay?.(text, tone);
  }

  /** Voice pitch in Hz: leads are lower, subagents vary, the player is bright. */
  get voicePitch() {
    if (this.role === 'player') return 260;
    let h = 0;
    for (let i = 0; i < this.id.length; i++) h = (h * 31 + this.id.charCodeAt(i)) >>> 0;
    const f0 = 170 + 22 * (h % 9);
    return this.role === 'sub' ? f0 * 1.15 : f0;
  }

  setActivity(a: Activity | null) {
    if (a?.kind !== this.activity?.kind || a?.detail !== this.activity?.detail) {
      this.activitySince = performance.now();
      this.leanedThisRun = false;
    }
    this.activity = a;
    this.notifying = !!this.pendingAsk; // keep the hand up while a question is open
    this.toolDoneAt = 0;
  }

  react(r: Omit<Reaction, 't'>) {
    if (this.reaction) this.reaction.onDone?.();
    this.reaction = { ...r, t: 0 };
    this.fidget = null;
  }

  endReaction() {
    const r = this.reaction;
    this.reaction = null;
    r?.onDone?.();
  }

  /** Spring impulse: positive squashes (landing), negative stretches (jump/fall). */
  kick(amount: number) {
    this.squashV += amount * 14;
  }

  pickUp() {
    if (this.reaction) this.endReaction();
    this.held = true;
    this.falling = false;
    this.seated = false;
    this.fidget = null;
    this.lastHeld.copy(this.position);
    this.kick(-0.5);
  }

  /** While held, the office moves the agent toward the cursor; velocity drives the dangle swing. */
  holdAt(p: THREE.Vector3, dt: number) {
    const k = 1 - Math.exp(-dt / 0.06);
    this.position.lerp(p, k);
    this.heldVel.subVectors(this.position, this.lastHeld).divideScalar(Math.max(dt, 1e-3));
    this.lastHeld.copy(this.position);
  }

  drop() {
    this.held = false;
    this.falling = true;
    this.vy = 0;
  }

  get yawAngle() {
    return this.yaw;
  }
  get spinAngle() {
    return this.spinOffset;
  }

  update(dt: number, g: number) {
    if (this.held || this.falling) {
      this.updateHeld(dt, g);
      return;
    }
    const r = this.reaction;
    if (r) {
      r.t += dt;
      r.onTick?.(r.t);
      if (r.t >= r.dur && this.reaction === r) this.endReaction();
    }
    this.reactW += ((this.reaction ? 1 : 0) - this.reactW) * (1 - Math.exp(-dt / (this.reaction ? 0.07 : 0.16)));
    const a = this.reaction?.hold ? null : this.cur;
    if (a) {
      if (!a.started) {
        a.started = true;
        a.onStart?.();
      }
      a.t += dt;
      this.step(a, dt);
      if (a.t >= a.dur && this.cur === a) {
        a.onDone?.();
        if (this.cur === a) this.next();
      }
    }
    this.computeTarget(g);
    this.updateFidget(dt, g);
    let spin = 0;
    if (this.reaction?.spin) spin = this.reaction.spin(this.reaction.t);
    else if (this.fidget?.def.spin) spin = this.fidget.def.spin(this.fidget.t);
    else if (this.cur?.kind === 'celebrate' && this.cur.variant === 2) spin = P.spinPumpYaw(this.cur.t);
    this.spinOffset = spin;
    if (this.reactW > 0.002) {
      P.copyPose(this.target, this.reactPose);
      const rr = this.reaction;
      if (rr) {
        const e = rr.pose(this.reactPose, rr.t, g, this.seated);
        if (e && e !== this.expression) {
          this.expression = e;
          setExpression(this.rig, e);
        }
      }
      P.lerpPose(this.target, this.reactPose, this.reactW, this.target);
    }
    // critically damped blend toward the target pose (doubles as a cross-fade between states)
    const k = 1 - Math.exp(-dt / (this.cur?.kind === 'walk' ? 0.05 : 0.09));
    P.lerpPose(this.pose, this.target, k, this.pose);
    this.apply(dt, g);
  }

  private updateHeld(dt: number, g: number) {
    const p = this.target;
    resetPose(p);
    if (this.held) {
      // pendulum swing driven by horizontal motion of the hand holding the agent
      const vx = THREE.MathUtils.clamp(this.heldVel.x, -6, 6);
      this.dangleV += (-this.dangle * 40 - this.dangleV * 3 - vx * 1.2) * dt;
      this.dangle = THREE.MathUtils.clamp(this.dangle + this.dangleV * dt, -0.9, 0.9);
      const kick = Math.sin(g * 14);
      P.leg(p, 'L', 0.5 * kick, 0.6 + 0.4 * kick);
      P.leg(p, 'R', -0.5 * kick, 0.6 - 0.4 * kick);
      P.arm(p, 'L', 0.8 + 0.6 * Math.sin(g * 11), 0.9, 0.4);
      P.arm(p, 'R', 0.8 + 0.6 * Math.sin(g * 11 + 2), 0.9, 0.4);
      p.r.spine[0] = -0.1;
      p.r.head[0] = 0.25;
      p.r.head[1] = 0.3 * Math.sin(g * 3);
      if (this.expression !== 'surprise') {
        this.expression = 'surprise';
        setExpression(this.rig, 'surprise');
      }
    } else {
      this.vy -= 12 * dt;
      this.position.y += this.vy * dt;
      this.dangle *= 1 - Math.min(1, dt * 6);
      P.arm(p, 'L', 2.6, 0.5, 0.2);
      P.arm(p, 'R', 2.6, 0.5, 0.2);
      P.leg(p, 'L', 0.3, 0.3);
      P.leg(p, 'R', 0.3, 0.3);
      if (this.position.y <= 0) {
        this.position.y = 0;
        this.falling = false;
        this.dangle = 0;
        this.kick(0.22 + Math.min(0.12, -this.vy / 40));
        this.sound?.('thud');
        this.onLanded?.();
      }
    }
    const k = 1 - Math.exp(-dt / 0.06);
    P.lerpPose(this.pose, p, k, this.pose);
    this.apply(dt, g);
    this.rig.body.rotation.z = this.dangle;
  }

  /** Small idle fidgets that make long work sessions look alive. Cosmetic only. */
  private updateFidget(dt: number, g: number) {
    if (this.reaction || this.notifying) {
      this.fidget = null;
      return;
    }
    const kind = this.cur?.kind;
    const desk = kind === 'work' && this.seated && this.spot?.kind === 'desk';
    const couch = kind === 'rest' && this.seated && this.spot?.kind === 'couch';
    if (!desk && !couch) {
      this.fidget = null;
      return;
    }
    if (!this.fidget) {
      this.fidgetAt -= dt;
      if (this.fidgetAt > 0) return;
      this.fidgetAt = 7 + Math.random() * 10;
      let pool = (desk ? FIDGETS_DESK : FIDGETS_COUCH).filter((x) => !x.when || x.when(this.activity?.kind));
      const runAge = performance.now() - this.activitySince;
      if (desk && this.activity?.kind === 'run' && runAge > 12000 && !this.leanedThisRun) {
        this.leanedThisRun = true;
        pool = pool.filter((x) => x.name === 'hands-behind-head');
      }
      if (!pool.length) return;
      const def = pool[Math.floor(Math.random() * pool.length)];
      this.fidget = { def, t: 0 };
      if (def.emote) this.emote?.(def.emote, def.dur);
    }
    const f = this.fidget;
    f.t += dt;
    const w = Math.max(0, Math.min(1, f.t / 0.3, (f.def.dur - f.t) / 0.35));
    P.copyPose(this.target, this.reactPose);
    const e = f.def.pose(this.reactPose, f.t, g);
    P.lerpPose(this.target, this.reactPose, w, this.target);
    if (e && w > 0.5 && e !== this.expression) {
      this.expression = e;
      setExpression(this.rig, e);
    }
    const sipping = f.def.name === 'sip-mug' && f.t > 0.35 && f.t < f.def.dur - 0.3;
    if (desk) {
      this.rig.mug.visible = sipping;
      const deskMug = (this.spot as unknown as { mug?: THREE.Object3D }).mug;
      if (deskMug && deskMug.scale.x > 0.5) deskMug.visible = !sipping;
    }
    if (f.t >= f.def.dur) this.fidget = null;
  }

  // ------------------------------------------------------------------------ motion

  private step(a: Action, dt: number) {
    switch (a.kind) {
      case 'walk': {
        const path = a.path!;
        let remaining = WALK_SPEED * dt;
        while (remaining > 0 && path.length) {
          const tgt = path[0];
          const dx = tgt.x - this.position.x;
          const dz = tgt.z - this.position.z;
          const d = Math.hypot(dx, dz);
          if (d < 0.02) {
            path.shift();
            continue;
          }
          const stepLen = Math.min(d, remaining);
          this.position.x += (dx / d) * stepLen;
          this.position.z += (dz / d) * stepLen;
          remaining -= stepLen;
          const want = Math.atan2(dx, dz);
          this.yaw += shortestAngle(this.yaw, want) * (1 - Math.exp(-dt / 0.08));
        }
        const prev = Math.sin(this.phase);
        this.phase += dt * Math.PI * 2 * STRIDE_HZ;
        if (Math.sign(Math.sin(this.phase)) !== Math.sign(prev)) {
          this.stepSide ^= 1;
          this.onEvent?.('step');
        }
        if (!path.length) a.dur = 0; // arrived
        break;
      }
      case 'turn': {
        const u = P.ease.outCubic(P.clamp01(a.t / a.dur));
        this.yaw = a.fromYaw! + shortestAngle(a.fromYaw!, a.toYaw!) * u;
        break;
      }
      case 'sit':
      case 'stand': {
        const sitting = a.kind === 'sit';
        const u = P.ease.inOutQuad(P.clamp01(a.t / a.dur));
        const to = a.to!;
        this.position.lerpVectors(a.from!, to, u);
        this.yaw = a.fromYaw! + shortestAngle(a.fromYaw!, a.toYaw!) * P.clamp01(u * 1.6);
        if (sitting && a.t >= a.dur && !this.seated) {
          this.seated = true;
          this.kick(0.1);
        }
        if (!sitting) this.seated = false;
        break;
      }
      case 'pop': {
        const u = P.clamp01(a.t / a.dur);
        this.rig.root.scale.setScalar(this.scale * P.ease.outBack(u));
        break;
      }
      case 'fade': {
        this.opacity = 1 - P.clamp01(a.t / a.dur);
        break;
      }
      case 'celebrate': {
        const prev = a.t - dt;
        if (a.variant !== 1 && prev < 0.3 && a.t >= 0.3) this.kick(-0.12); // stretch on take-off
        if (a.variant !== 1 && prev < 0.9 && a.t >= 0.9) this.kick(0.22); // squash on landing
        break;
      }
    }
  }

  // ------------------------------------------------------------------------ poses

  private computeTarget(g: number) {
    const p = this.target;
    const q = this.quirks;
    const a = this.cur;
    resetPose(p);
    let expr: Expression = 'neutral';
    const kind = a?.kind ?? 'rest';
    const spotKind = this.spot?.kind;
    this.rig.mug.visible = false;
    this.rig.phone.visible = false;

    if (this.drive) {
      expr = this.drive(p, g);
    } else switch (kind) {
      case 'walk':
        P.walk(p, this.phase, q);
        if (a!.t < 0.2) p.r.spine[0] += 0.18 * (1 - a!.t / 0.2); // anticipation lean
        break;
      case 'pop':
      case 'turn':
        P.standIdle(p, g, q);
        expr = 'happy';
        break;
      case 'sit':
      case 'stand': {
        const u = P.ease.inOutQuad(P.clamp01(a!.t / a!.dur));
        const k = kind === 'sit' ? u : 1 - u;
        P.standIdle(this.tmpA, g, q);
        this.seatPose(this.tmpB, g, true);
        P.lerpPose(this.tmpA, this.tmpB, k, p);
        if (kind === 'stand' && u < 0.3) p.r.spine[0] += 0.25 * Math.sin((u / 0.3) * Math.PI); // push off
        break;
      }
      case 'work':
        expr = this.seatPose(p, g, false);
        break;
      case 'rest':
        if (spotKind === 'couch' && this.seated) {
          const prop = q.seed > 0.55 ? 'phone' : 'mug';
          P.couch(p, g, q, prop);
          this.rig.mug.visible = prop === 'mug';
          this.rig.phone.visible = prop === 'phone';
          expr = 'happy';
        } else if (spotKind === 'board') {
          P.whiteboard(p, g, q);
          expr = 'focus';
        } else {
          P.standIdle(p, g, q);
          if (spotKind === 'stand') {
            // sipping coffee by the machine
            const sip = Math.max(0, Math.sin(g * 0.7 + q.seed * 9)) ** 6;
            P.arm(p, 'R', 0.6 + 0.9 * sip, -0.05, 1.4 + 1.0 * sip);
            this.rig.mug.visible = true;
          }
        }
        break;
      case 'celebrate':
        if (a!.variant === 1) {
          P.dance(p, a!.t);
          if (a!.t < 0.05) this.emote?.('music', 2);
        } else if (a!.variant === 2) P.spinPump(p, a!.t);
        else P.celebrate(p, a!.t);
        expr = a!.variant === 1 ? 'laugh' : 'happy';
        break;
      case 'stretch':
        P.stretch(p, a!.t);
        expr = a!.t > 0.5 && a!.t < 1.2 ? 'surprise' : 'happy';
        break;
      case 'fade':
        P.standIdle(p, g, q);
        expr = 'happy';
        P.arm(p, 'R', 2.6, -0.3 + 0.25 * Math.sin(g * 10), 0.3); // bye!
        break;
    }
    if (this.notifying) {
      P.raiseHand(p, g);
      expr = 'concern';
    }
    if (expr !== this.expression) {
      this.expression = expr;
      setExpression(this.rig, expr);
    }
  }

  /** Pose for sitting at the current spot, chosen by the current activity. */
  private seatPose(p: P.Pose, g: number, transition: boolean): Expression {
    const q = this.quirks;
    if (this.spot?.kind === 'couch') {
      P.couch(p, g, q, 'mug');
      return 'happy';
    }
    if (this.spot?.kind === 'board') {
      P.whiteboard(p, g, q);
      return 'focus';
    }
    if (transition) {
      P.typing(p, g, q, 0.2);
      return 'neutral';
    }
    const act = this.activity;
    const kind = act?.kind ?? 'think';
    const stale = this.toolDoneAt && performance.now() - this.toolDoneAt > 2500;
    switch (stale ? 'think' : kind) {
      case 'think':
        P.thinking(p, g, q);
        return 'curious';
      case 'read':
        P.reading(p, g, q);
        return 'focus';
      case 'write':
      case 'todo':
        P.typing(p, g, q, this.rig.variant === 1 ? 1.4 : 1.3);
        if (this.rig.variant === 1) p.r.head[0] += 0.06 * Math.sin(g * Math.PI * 4); // vibing to music
        return 'focus';
      case 'run':
        P.running(p, g, q);
        return 'neutral';
      case 'search':
        P.searching(p, g, q);
        return 'curious';
      case 'web':
        P.reading(p, g, q);
        p.r.spine[0] = 0.18;
        return 'focus';
      case 'delegate':
        P.delegating(p, g, q);
        return 'happy';
      default:
        P.typing(p, g, q, 0.8);
        return 'focus';
    }
  }

  // ------------------------------------------------------------------------ apply to rig

  private apply(dt: number, g: number) {
    const rig = this.rig;
    for (const j of JOINTS) {
      const r = this.pose.r[j];
      rig.joints[j].rotation.set(r[0], r[1], r[2]);
    }
    rig.body.position.y = this.pose.lift;
    rig.root.rotation.y = this.yaw + this.spinOffset;
    rig.body.rotation.z = 0;
    // squash & stretch spring
    this.squashV += (-this.squash * 180 - this.squashV * 14) * dt;
    this.squash += this.squashV * dt;
    const sq = THREE.MathUtils.clamp(this.squash, -0.35, 0.35);
    rig.body.scale.set(1 + sq * 0.5, 1 - sq, 1 + sq * 0.5);
    // head and eyes follow the cursor when it hovers nearby
    let wantYaw = 0;
    let wantPitch = 0;
    if (this.lookAt && !this.held) {
      const hp = this.headWorld(LOOK_TMP);
      const dx = this.lookAt.x - hp.x;
      const dz = this.lookAt.z - hp.z;
      const dy = this.lookAt.y - hp.y;
      wantYaw = THREE.MathUtils.clamp(shortestAngle(this.yaw, Math.atan2(dx, dz)), -1.0, 1.0);
      wantPitch = THREE.MathUtils.clamp(-Math.atan2(dy, Math.hypot(dx, dz)), -0.5, 0.5);
    }
    const lk = 1 - Math.exp(-dt / 0.15);
    this.lookYaw += (wantYaw - this.lookYaw) * lk;
    this.lookPitch += (wantPitch - this.lookPitch) * lk;
    rig.joints.head.rotation.y += this.lookYaw * 0.8;
    rig.joints.head.rotation.x += this.lookPitch * 0.6;
    const eyeShift = THREE.MathUtils.clamp(this.lookYaw * 0.025, -0.014, 0.014);
    rig.eyes[0].position.x = -0.085 + eyeShift;
    rig.eyes[1].position.x = 0.085 + eyeShift;
    if (this.popT < 1) {
      this.popT = Math.min(1, this.popT + dt / 0.45);
      rig.root.scale.setScalar(this.scale * Math.max(0.001, P.ease.outBack(this.popT)));
      if (this.popT >= 1) this.kick(0.1);
    }

    // blink
    this.blinkAt -= dt;
    if (this.blinkAt <= 0 && this.blinkT < 0) {
      this.blinkT = 0;
      this.blinkAt = 2 + Math.random() * 3;
    }
    let eyeY = this.expression === 'focus' ? 0.85 : this.expression === 'sleepy' ? 0.45 : this.expression === 'laugh' ? 0.3 : 1;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const u = this.blinkT / 0.14;
      eyeY *= u < 1 ? Math.max(0.08, Math.abs(1 - 2 * u)) : 1;
      if (u >= 1) this.blinkT = -1;
    }
    for (const e of rig.eyes) e.scale.y = eyeY;

    // badge spin (faster while dispatching subagents)
    if (rig.badge) {
      const want = this.activity?.kind === 'delegate' && this.busyWorking ? 4 : 1;
      this.badgeSpin += (want - this.badgeSpin) * Math.min(1, dt * 2);
      rig.badge.rotation.y += this.badgeSpin * dt;
      rig.badge.position.y = 0.64 + 0.02 * Math.sin(g * 2);
    }
    // springy antenna reacting to turning and walking
    if (rig.antenna) {
      const yawVel = shortestAngle(this.lastYaw, this.yaw) / Math.max(dt, 1e-3);
      const force = -this.antennaAng * 60 - this.antennaVel * 6 + (this.walking ? Math.sin(this.phase * 2) * 6 : 0) - yawVel * 2;
      this.antennaVel += force * dt;
      this.antennaAng += this.antennaVel * dt;
      rig.antenna.rotation.z = THREE.MathUtils.clamp(this.antennaAng, -0.5, 0.5);
    }
    this.lastYaw = this.yaw;

    if (this.opacity < 1) {
      for (const m of rig.materials) {
        m.transparent = true;
        m.opacity = this.opacity;
      }
    }
  }

  headWorld(out: THREE.Vector3) {
    this.rig.joints.head.getWorldPosition(out);
    out.y += 0.62 * this.scale;
    return out;
  }
}

/** Keeps object identity so callers can mutate an action (e.g. fill a path) from its callbacks. */
function prep(a: Partial<Action>): Action {
  return Object.assign(a, { t: 0, dur: a.dur ?? Infinity, started: false }) as Action;
}

function resetPose(p: P.Pose) {
  for (const j of JOINTS) {
    p.r[j][0] = 0;
    p.r[j][1] = 0;
    p.r[j][2] = 0;
  }
  p.lift = 0;
}
