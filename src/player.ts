// The user's own character, per the Fable design spec: camera-relative movement (W/S/A/D or ↑/↓),
// ←/→ rotate the view, Shift run, Space jump, E wave / high-five, V cycles third person → first person → overview.
import * as THREE from 'three';
import { Agent } from './agent';
import { PLAYER_VARIANT, type Expression, type Gender } from './character';
import { trimShadowCasters } from './perf';
import { C } from './palette';
import * as P from './pose';
import type { Colliders, Circle } from './colliders';
import { localOf } from './world';
import type { Office } from './office';
import type { Sound } from './sound';
import type { Effects } from './effects';
import * as R from './reactions';

export type CamMode = 'orbit' | 'third' | 'first';

export const FEEL = {
  walk: 1.9,
  run: 3.6,
  tauAccel: 0.12,
  tauDecel: 0.08,
  airControl: 0.6,
  rotate: 2.4, // rad/s with ←/→
  faceTau: 0.1,
  gravity: 18,
  jumpV: 4.02, // ≈ 0.45 m hop
  coyote: 0.1,
  buffer: 0.12,
  radius: 0.22,
  eye: 1.03,
  fovFirst: 70,
  fovThird: 55,
  arm: 3.2,
  armMin: 1.8,
  armMax: 4.5,
  pivot: 1.1,
  shoulder: 0.35,
  pitchThird: 0.32,
};

const tmp = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class Player {
  agent!: Agent;
  gender: Gender = 'm';
  playerName = 'You';
  mode: CamMode = 'orbit';
  spawned = false;
  /** absolute world yaw of the view (third/first person) */
  viewYaw = Math.PI / 2;
  viewPitch = FEEL.pitchThird;
  private keys = new Set<string>();
  private vel = new THREE.Vector3();
  private vy = 0;
  private grounded = true;
  private sinceGround = 0;
  private jumpBuffered = -1;
  private crouchT = -1;
  private landT = -1;
  private waveT = -1;
  private bodyYaw = Math.PI / 2;
  private phase = 0;
  private speed = 0;
  private arm = FEEL.arm;
  private armCur = FEEL.arm;
  private trans = { t: 1, dur: 0.45, pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fov: 38 };
  private dragLook: { x: number; y: number } | null = null;
  private marker: THREE.Mesh;
  private bumped = new Map<string, number>();
  orbitYaw = 0; // set by main from the overview camera, so keys move relative to what you see
  /** While chatting, turn toward the agent you are talking to. */
  listenTarget: THREE.Vector3 | null = null;
  /** Sitting at the manager desk (position and facing are fixed until you move). */
  seat: { pos: THREE.Vector3; yaw: number; stand: THREE.Vector3 } | null = null;
  onStandUp?: () => void;
  private nodT = -1;
  onModeChange?: (m: CamMode) => void;
  onSpawn?: () => void;

  constructor(
    private scene: THREE.Scene,
    private colliders: Colliders,
    private office: Office,
    private sound: Sound,
    private fx: Effects,
    private canvas: HTMLCanvasElement,
  ) {
    this.makeAgent();
    // floating "plumbob" so you can always find yourself
    this.marker = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.07),
      new THREE.MeshStandardMaterial({ color: C.mint, emissive: C.mint, emissiveIntensity: 0.9, roughness: 0.3 }),
    );
    this.marker.scale.set(1, 1.5, 1);
    this.marker.position.y = 1.62;
    this.agent.rig.root.add(this.marker);

    addEventListener('keydown', (e) => this.onKey(e, true));
    addEventListener('keyup', (e) => this.onKey(e, false));
    addEventListener('blur', () => this.keys.clear());

    // third person / overview: left-drag on empty space looks around (tease claims agent clicks first)
    canvas.addEventListener('pointerdown', (e) => {
      if (this.mode === 'third' && e.button === 0) this.dragLook = { x: e.clientX, y: e.clientY };
      // first person: click captures the mouse (pointer lock); clicks then fire the tool at the crosshair
      if (this.mode === 'first' && document.pointerLockElement !== canvas) canvas.requestPointerLock?.();
    });
    addEventListener('pointermove', (e) => {
      if (this.mode === 'first' && document.pointerLockElement === canvas) {
        this.viewYaw -= e.movementX * 0.0022;
        this.viewPitch = THREE.MathUtils.clamp(this.viewPitch - e.movementY * 0.0022, -1.3, 1.3);
        return;
      }
      if (!this.dragLook) return;
      const dx = e.clientX - this.dragLook.x;
      const dy = e.clientY - this.dragLook.y;
      this.dragLook = { x: e.clientX, y: e.clientY };
      this.viewYaw -= dx * 0.0045;
      this.viewPitch = THREE.MathUtils.clamp(this.viewPitch + dy * 0.0045, -0.4, 1.2);
    });
    addEventListener('pointerup', () => (this.dragLook = null));
    canvas.addEventListener(
      'wheel',
      (e) => {
        if (this.mode !== 'third') return;
        e.preventDefault();
        e.stopImmediatePropagation();
        this.arm = THREE.MathUtils.clamp(this.arm + e.deltaY * 0.003, FEEL.armMin, FEEL.armMax);
      },
      { passive: false, capture: true },
    );
  }

  private makeAgent() {
    this.agent = new Agent('player', 'player', PLAYER_VARIANT, 'player', this.playerName, '', this.gender, 'player:' + this.playerName);
    this.agent.drive = (p, g) => this.pose(p, g);
    trimShadowCasters(this.agent.rig.root);
  }

  /** Switch between the male and female character (and rename), keeping position and heading. */
  setLook(gender: Gender, name: string) {
    this.gender = gender;
    this.playerName = name || 'You';
    const old = this.agent;
    const pos = old.position.clone();
    const yaw = old.yawAngle;
    if (this.spawned) this.scene.remove(old.rig.root);
    old.rig.root.remove(this.marker);
    this.makeAgent();
    this.agent.rig.root.add(this.marker);
    if (this.spawned) {
      this.scene.add(this.agent.rig.root);
      this.agent.place(pos, yaw);
      this.agent.popIn();
      this.agent.say(`Hi, I'm ${this.playerName}!`, 'say', 2);
    }
  }

  get position() {
    return this.agent.position;
  }

  sit(pos: THREE.Vector3, yaw: number, stand: THREE.Vector3) {
    this.seat = { pos: pos.clone(), yaw, stand: stand.clone() };
    this.vel.set(0, 0, 0);
    this.agent.place(pos, yaw);
    this.bodyYaw = yaw;
    this.viewYaw = yaw;
    this.viewPitch = this.mode === 'first' ? -0.1 : 0.42;
    this.agent.kick(0.1);
    this.sound.chair(pos.clone().setY(0.5));
  }

  standUp() {
    if (!this.seat) return;
    const s = this.seat;
    this.seat = null;
    this.agent.place(s.stand, this.bodyYaw);
    this.onStandUp?.();
  }

  releaseKeys() {
    this.keys.clear();
  }

  nod() {
    this.nodT = 0;
  }
  get locked() {
    return document.pointerLockElement === this.canvas;
  }

  spawn(at: THREE.Vector3, yaw: number) {
    if (this.spawned) return;
    this.spawned = true;
    this.scene.add(this.agent.rig.root);
    this.agent.place(at, yaw);
    this.bodyYaw = yaw;
    this.viewYaw = yaw;
    this.agent.popIn();
    this.agent.say('Hello office! 👋', 'say', 2.5);
    this.sound.pop(at.clone().setY(1));
    this.onSpawn?.();
  }

  setMode(m: CamMode, camera: THREE.PerspectiveCamera) {
    if (m === this.mode) return;
    const prev = this.mode;
    this.trans = {
      t: 0,
      dur: prev === 'orbit' || m === 'orbit' ? 0.45 : 0.3,
      pos: camera.position.clone(),
      quat: camera.quaternion.clone(),
      fov: camera.fov,
    };
    if (prev === 'orbit') this.viewYaw = this.bodyYaw;
    this.viewPitch = m === 'first' ? 0 : FEEL.pitchThird;
    this.mode = m;
    if (m !== 'first' && this.locked) document.exitPointerLock();
    this.onModeChange?.(m);
  }

  /** V: third person → first person → overview → third person. */
  cycleMode(camera: THREE.PerspectiveCamera) {
    this.setMode(this.mode === 'third' ? 'first' : this.mode === 'first' ? 'orbit' : 'third', camera);
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const MOVE = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd', 'Shift', ' '];
    if (!MOVE.includes(k)) return;
    if (k.startsWith('Arrow') || k === ' ') e.preventDefault();
    if (down) {
      this.keys.add(k);
      if (!this.spawned) this.onFirstMove?.();
      if (k === ' ') this.jumpBuffered = 0;
    } else this.keys.delete(k);
  }
  onFirstMove?: () => void;

  // ------------------------------------------------------------------ simulation

  update(dt: number, g: number, camera: THREE.PerspectiveCamera) {
    if (this.spawned) this.move(dt);
    this.agent.update(dt, g);
    if (this.spawned) {
      this.marker.rotation.y += 1.2 * dt;
      this.marker.position.y = 1.62 + 0.03 * Math.sin(g * Math.PI * 2 * 1.2);
      this.marker.visible = this.mode !== 'first';
    }
    this.updateCamera(dt, camera);
  }

  private move(dt: number) {
    const k = this.keys;
    if (this.seat) {
      const moving = ['ArrowUp', 'ArrowDown', 'w', 'a', 's', 'd', ' '].some((x) => k.has(x));
      if (!moving) {
        const rotS = (k.has('ArrowLeft') ? 1 : 0) - (k.has('ArrowRight') ? 1 : 0);
        this.viewYaw += rotS * FEEL.rotate * dt;
        this.speed = 0;
        this.agent.place(this.seat.pos, this.seat.yaw);
        return;
      }
      this.standUp();
    }
    const inTransition = this.trans.t < 1;
    let fwd = (k.has('ArrowUp') || k.has('w') ? 1 : 0) - (k.has('ArrowDown') || k.has('s') ? 1 : 0);
    let strafe = (k.has('d') ? 1 : 0) - (k.has('a') ? 1 : 0);
    const rot = (k.has('ArrowLeft') ? 1 : 0) - (k.has('ArrowRight') ? 1 : 0);
    if (inTransition) fwd = strafe = 0;
    const run = k.has('Shift');
    // ←/→ rotate the view (and in overview, steer the character directly)
    if (this.mode === 'orbit') this.bodyYawTurn(rot, dt);
    else this.viewYaw += rot * FEEL.rotate * dt;

    const yaw = this.mode === 'orbit' ? this.orbitYaw : this.viewYaw;
    const f = tmp.set(Math.sin(yaw), 0, Math.cos(yaw));
    const r = new THREE.Vector3(-f.z, 0, f.x); // camera right
    const dir = new THREE.Vector3().addScaledVector(f, fwd).addScaledVector(r, strafe);
    if (this.mode === 'orbit' && rot && !fwd && !strafe) dir.set(0, 0, 0);
    if (dir.lengthSq() > 1) dir.normalize();
    const max = run ? FEEL.run : FEEL.walk;
    const want = dir.multiplyScalar(max);
    const tau = dir.lengthSq() > 0 ? FEEL.tauAccel : FEEL.tauDecel;
    const ctl = this.grounded ? 1 : FEEL.airControl;
    this.vel.lerp(want, (1 - Math.exp(-dt / tau)) * ctl);

    const p = this.position;
    p.x += this.vel.x * dt;
    p.z += this.vel.z * dt;

    // facing: move direction in third person / overview, view direction in first person
    this.speed = Math.hypot(this.vel.x, this.vel.z);
    if (this.mode === 'first') this.bodyYaw = this.viewYaw;
    else if (this.listenTarget && this.speed < 0.15) {
      const to = this.listenTarget.clone().sub(this.position);
      if (to.lengthSq() < 16) this.bodyYaw += shortest(this.bodyYaw, Math.atan2(to.x, to.z)) * (1 - Math.exp(-dt / 0.25));
    } else if (this.speed > 0.15) {
      const target = Math.atan2(this.vel.x, this.vel.z);
      this.bodyYaw += shortest(this.bodyYaw, target) * (1 - Math.exp(-dt / FEEL.faceTau));
    }

    // jump with coyote time and input buffering
    this.sinceGround = this.grounded ? 0 : this.sinceGround + dt;
    if (this.jumpBuffered >= 0) {
      this.jumpBuffered += dt;
      if (this.jumpBuffered > FEEL.buffer) this.jumpBuffered = -1;
      else if ((this.grounded || this.sinceGround < FEEL.coyote) && this.crouchT < 0 && this.vy <= 0) {
        this.jumpBuffered = -1;
        this.crouchT = 0;
      }
    }
    if (this.crouchT >= 0) {
      this.crouchT += dt;
      if (this.crouchT >= 0.08) {
        this.crouchT = -1;
        this.vy = FEEL.jumpV;
        this.grounded = false;
        this.agent.kick(-0.14);
        this.sound.jump(p.clone());
      }
    }
    if (!this.grounded) {
      this.vy -= FEEL.gravity * dt;
      p.y += this.vy * dt;
      if (p.y <= 0) {
        p.y = 0;
        this.vy = 0;
        this.grounded = true;
        this.landT = 0;
        this.agent.kick(this.speed > FEEL.walk + 0.3 ? 0.18 : 0.12);
        this.sound.land(p.clone());
        for (let i = 0; i < 4; i++) this.fx.steam(p.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.3, 0.03, (Math.random() - 0.5) * 0.3)));
      }
    }
    if (this.landT >= 0 && (this.landT += dt) > 0.18) this.landT = -1;

    // collisions: furniture, then agents (the player always yields)
    const agents = [...this.office.agents.values()].filter((a) => !a.removed && !a.held);
    const circles: Circle[] = agents.map((a) => ({ x: a.position.x, z: a.position.z, r: a.role === 'sub' ? 0.2 : 0.22 }));
    const chairCircles = this.office.chairCircles();
    const hit = this.colliders.resolve(p, FEEL.radius, [...circles, ...chairCircles]);
    if (hit >= 0 && hit < agents.length) this.bump(agents[hit]);

    this.agent.place(p, this.bodyYaw);
    if (this.speed > 0.2 && this.grounded) {
      const runK = THREE.MathUtils.clamp((this.speed - FEEL.walk) / (FEEL.run - FEEL.walk), 0, 1);
      const hz = 2.0 + 0.8 * runK;
      const prev = this.phase;
      this.phase += dt * Math.PI * 2 * hz * Math.min(1, this.speed / FEEL.walk);
      if (Math.floor(prev / Math.PI) !== Math.floor(this.phase / Math.PI)) {
        const l = localOf(p);
        const onRug = l.x > -6.4 && l.x < -3.8 && l.z > 0.1 && l.z < 3.1;
        this.sound.step(p.clone(), onRug, runK > 0.3 ? 1.4 : 1, true);
      }
    }
  }

  private bodyYawTurn(rot: number, dt: number) {
    if (!rot) return;
    this.bodyYaw += rot * FEEL.rotate * dt;
    this.orbitYaw = this.bodyYaw;
  }

  private pose(p: P.Pose, g: number): Expression {
    const q = { seed: 0.42, glanceAt: 0, glanceDir: 0 };
    if (this.seat) {
      // the boss at work: leaning back a little, one hand on the desk
      P.seatedBase(p, P.DESK_LIFT, g, q);
      p.r.spine[0] = -0.05;
      P.arm(p, 'L', 0.6, 0.18, 1.0);
      P.arm(p, 'R', 0.5, 0.2, 1.1 + 0.05 * Math.sin(g * 2));
      p.r.head[0] = 0.02;
      return 'happy';
    }
    if (this.crouchT >= 0) {
      P.standIdle(p, g, q);
      P.leg(p, 'L', 0.3, 0.6);
      P.leg(p, 'R', 0.3, 0.6);
      P.arm(p, 'L', -0.3, 0.2, 0.3);
      P.arm(p, 'R', -0.3, 0.2, 0.3);
      p.r.spine[0] = 0.2;
      p.lift = -0.06;
      return 'happy';
    }
    if (!this.grounded) {
      if (this.vy > 0) {
        P.arm(p, 'L', 2.2, 0.35, 0.3);
        P.arm(p, 'R', 2.2, 0.35, 0.3);
        P.leg(p, 'L', 0.9, 1.2);
        P.leg(p, 'R', 0.2, 0.4);
      } else {
        P.arm(p, 'L', 1.6, 0.35, 0.3);
        P.arm(p, 'R', 1.6, 0.35, 0.3);
        P.leg(p, 'L', 0.2, 0.3);
        P.leg(p, 'R', 0.2, 0.3);
      }
      return 'happy';
    }
    if (this.speed > 0.2) {
      P.walk(p, this.phase, q);
      if (this.speed > 2.6) {
        p.r.spine[0] += 0.12;
        p.r.shL[0] *= 1.4;
        p.r.shR[0] *= 1.4;
        p.lift *= 1.5;
        p.r.head[0] -= 0.05;
      }
    } else P.standIdle(p, g, q);
    if (this.landT >= 0) {
      const k = Math.sin(Math.PI * (this.landT / 0.18));
      p.lift -= 0.08 * k;
      P.leg(p, 'L', 0.4 * k, 0.9 * k);
      P.leg(p, 'R', 0.4 * k, 0.9 * k);
      p.r.spine[0] += 0.25 * k;
    }
    if (this.nodT >= 0) {
      this.nodT += 1 / 60;
      p.r.head[0] += 0.12 * Math.sin(Math.PI * Math.min(1, this.nodT / 0.5));
      if (this.nodT > 0.5) this.nodT = this.listenTarget && Math.random() < 0.3 ? -3 * 60 : -1;
    } else if (this.nodT < -1) {
      this.nodT += 1 / 60;
      if (this.nodT >= -1) this.nodT = 0;
    }
    if (this.waveT >= 0) {
      this.waveT += 1 / 60;
      P.arm(p, 'R', 2.7, 0.4, 0.5 + 0.5 * Math.sin(Math.PI * 2 * 3 * this.waveT));
      p.r.head[2] = 0.1;
      if (this.waveT > 1.1) this.waveT = -1;
    }
    return 'happy';
  }

  /** E: wave at whoever is in front of you, or high-five if they are standing close by. */
  interact(): Agent | null {
    if (!this.spawned) return null;
    this.waveT = 0;
    const p = this.position;
    let best: Agent | null = null;
    let bd = 2.6;
    const facing = new THREE.Vector3(Math.sin(this.bodyYaw), 0, Math.cos(this.bodyYaw));
    for (const a of this.office.agents.values()) {
      if (a.removed || a.held || a.falling) continue;
      const to = a.position.clone().sub(p).setY(0);
      const d = to.length();
      if (d < bd && (d < 0.9 || to.normalize().dot(facing) > -0.1)) {
        bd = d;
        best = a;
      }
    }
    if (!best) {
      this.agent.say('hi everyone!', 'say', 1.5);
      return null;
    }
    const a = best;
    const five = bd < 1.1 && !a.seated && !a.walking;
    setTimeout(() => {
      if (a.removed) return;
      a.react(five ? R.highFive(a, p.clone()) : a.busyWorking && a.seated ? R.nod(a, p.clone()) : R.waveBack(a, p.clone()));
      a.say(five ? pick(['✋ High five!', 'Yeah! 🙌', 'Nice one!']) : pick(['Hey!', 'Hi there!', 'o/', 'Hello, human!']), 'say', 1.8);
    }, 250);
    if (five) {
      this.agent.say('✋', 'say', 1);
      setTimeout(() => {
        this.sound.clap(a.position.clone().setY(1.2));
        this.office.emote(a, 'stars', 1);
      }, 600);
    } else this.agent.say(pick(['hey!', 'hi!', 'o/']), 'say', 1.2);
    return a;
  }

  private bump(a: Agent) {
    const now = performance.now();
    if (now - (this.bumped.get(a.id) ?? 0) < 6000) return;
    this.bumped.set(a.id, now);
    if (a.reaction) return;
    this.sound.bonk(a.position.clone().setY(1), 0.5);
    if (a.walking) a.say('Coming through!', 'say', 1.4);
    else {
      a.say(pick(['Oh! Excuse me.', 'Oops, sorry', 'personal space!']), 'say', 1.6);
      if (!a.seated) a.react(R.nudged(a, this.position.clone()));
    }
  }

  // ------------------------------------------------------------------ camera

  private updateCamera(dt: number, camera: THREE.PerspectiveCamera) {
    const head = this.agent.rig.joints.head;
    if (this.mode === 'orbit') {
      head.visible = true;
      this.trans.t = 1;
      return;
    }
    const p = this.position;
    const goal = new THREE.Vector3();
    const look = new THREE.Vector3();
    let fov: number;
    if (this.mode === 'first') {
      const runK = THREE.MathUtils.clamp((this.speed - FEEL.walk) / (FEEL.run - FEEL.walk), 0, 1);
      const sp = Math.min(1, this.speed / FEEL.walk) * (this.grounded ? 1 : 0);
      const bobY = (0.018 + 0.012 * runK) * Math.abs(Math.sin(this.phase)) * sp;
      const bobX = 0.008 * Math.sin(this.phase) * sp;
      const f = new THREE.Vector3(Math.sin(this.viewYaw), 0, Math.cos(this.viewYaw));
      const r = new THREE.Vector3(-f.z, 0, f.x);
      goal.set(p.x, p.y + FEEL.eye + bobY - (this.landT >= 0 ? 0.05 * Math.sin(Math.PI * (this.landT / 0.18)) : 0), p.z).addScaledVector(f, 0.08).addScaledVector(r, bobX);
      look.set(Math.sin(this.viewYaw) * Math.cos(this.viewPitch), Math.sin(this.viewPitch), Math.cos(this.viewYaw) * Math.cos(this.viewPitch)).add(goal);
      fov = FEEL.fovFirst;
      head.visible = false;
    } else {
      const pivot = new THREE.Vector3(p.x, p.y + FEEL.pivot, p.z);
      const back = new THREE.Vector3(-Math.sin(this.viewYaw) * Math.cos(this.viewPitch), Math.sin(this.viewPitch), -Math.cos(this.viewYaw) * Math.cos(this.viewPitch));
      const right = new THREE.Vector3(-Math.cos(this.viewYaw), 0, Math.sin(this.viewYaw)); // camera right
      const want = pivot.clone().addScaledVector(back, this.arm).addScaledVector(right, FEEL.shoulder);
      const clear = this.colliders.clearDistance(pivot, want, want.y) - 0.15;
      const target = Math.max(0.6, Math.min(this.arm, clear));
      this.armCur += (target - this.armCur) * (1 - Math.exp(-dt / (target < this.armCur ? 0.03 : 0.25)));
      goal.copy(pivot).addScaledVector(back, this.armCur).addScaledVector(right, FEEL.shoulder * Math.min(1, this.armCur / this.arm));
      look.copy(pivot).addScaledVector(right, FEEL.shoulder * 0.6);
      fov = FEEL.fovThird;
      head.visible = true;
    }
    const goalQuat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(goal, look, UP));
    if (this.trans.t < 1) {
      this.trans.t = Math.min(1, this.trans.t + dt / this.trans.dur);
      const u = P.ease.inOutSine(this.trans.t);
      camera.position.lerpVectors(this.trans.pos, goal, u);
      camera.quaternion.slerpQuaternions(this.trans.quat, goalQuat, u);
      camera.fov = this.trans.fov + (fov - this.trans.fov) * u;
    } else if (this.mode === 'first') {
      camera.position.copy(goal);
      camera.quaternion.copy(goalQuat);
      camera.fov = fov;
    } else {
      camera.position.lerp(goal, 1 - Math.exp(-dt / 0.09));
      camera.quaternion.slerp(goalQuat, 1 - Math.exp(-dt / 0.06));
      camera.fov = fov;
    }
    camera.updateProjectionMatrix();
  }
}

function shortest(a: number, b: number) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function pick<T>(a: T[]) {
  return a[Math.floor(Math.random() * a.length)];
}
