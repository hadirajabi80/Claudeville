// Teasing tools: poke, tickle, drag & drop, paper balls, water, monitor switch, chair pull, duck.
// Everything here is cosmetic: agents always go back to exactly what their live session needs.
import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Agent } from './agent';
import type { Office } from './office';
import type { World, Desk } from './world';
import type { Emotes, EmoteKind } from './emotes';
import type { Sound } from './sound';
import * as R from './reactions';

export type Tool = 'hand' | 'slap' | 'smack' | 'paper' | 'water' | 'power' | 'mug' | 'spin' | 'chair' | 'duck';
export const TOOLS: Tool[] = ['hand', 'slap', 'smack', 'paper', 'water', 'power', 'mug', 'spin', 'chair', 'duck'];

interface Ball {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  life: number;
  resting: number;
  from?: Agent; // thrown by an agent at the camera
  kind: 'paper' | 'drop' | 'duck';
  looked?: boolean;
}

const GRAVITY = 9.8;

export interface TeaseDeps {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  controls: OrbitControls;
  office: Office;
  world: World;
  emotes: Emotes;
  sound: Sound;
  splat: (kind: 'paper' | 'water' | 'slap') => void;
  shake: (amount: number) => void;
}

export class Tease {
  tool: Tool = 'hand';
  private ray = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private down: { x: number; y: number; agent: Agent | null; t: number } | null = null;
  private dragging: Agent | null = null;
  private annoy = new Map<string, number>();
  private clicks = new Map<string, number[]>();
  private balls: Ball[] = [];
  private spraying = false;
  private sprayAcc = 0;
  private cursor = new THREE.Vector3();
  private cursorValid = false;
  private hoverAgent: Agent | null = null;
  private paperGeo: THREE.BufferGeometry;
  private paperMat = new THREE.MeshStandardMaterial({ color: 0xf7f4ee, roughness: 0.9, flatShading: true });
  private dropGeo = new THREE.SphereGeometry(0.025, 6, 5);
  private dropMat = new THREE.MeshStandardMaterial({ color: 0x7cc3f2, roughness: 0.2, transparent: true, opacity: 0.85 });
  private duckProto: THREE.Group;
  private wetUntil = new Map<string, number>();
  private rightClaimed = false;
  private lastSpin = new Map<string, number>();
  onToolChange?: (t: Tool) => void;

  constructor(private d: TeaseDeps) {
    // crumpled paper: a noisy icosahedron
    const g = new THREE.IcosahedronGeometry(0.07, 1);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const k = 0.75 + Math.random() * 0.45;
      pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * k, pos.getZ(i) * k);
    }
    g.computeVertexNormals();
    this.paperGeo = g;
    this.duckProto = makeDuck();

    // capture phase so we can claim the gesture before OrbitControls starts rotating
    const el = d.canvas;
    el.addEventListener('pointerdown', (e) => this.onDown(e), { capture: true });
    addEventListener('pointermove', (e) => this.onMove(e));
    addEventListener('pointerup', (e) => this.onUp(e));
    // never leave an agent dangling if the release happens outside the page
    addEventListener('pointercancel', () => this.cancelGesture());
    addEventListener('blur', () => this.cancelGesture());
    el.addEventListener('pointerleave', () => (this.cursorValid = false));
    el.addEventListener('contextmenu', (e) => {
      if (this.rightClaimed) e.preventDefault();
      this.rightClaimed = false;
    });
    addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      const n = e.key === '0' ? 10 : parseInt(e.key, 10);
      if (n >= 1 && n <= TOOLS.length) this.setTool(TOOLS[n - 1]);
      if (e.key === 'Escape') this.setTool('hand');
    });
  }

  setTool(t: Tool) {
    this.tool = t;
    this.d.canvas.style.cursor = t === 'hand' ? 'grab' : 'crosshair';
    this.onToolChange?.(t);
  }

  // ------------------------------------------------------------------ picking

  private setRay(e: PointerEvent) {
    // first person with a captured mouse: tools fire at the crosshair
    if (document.pointerLockElement === this.d.canvas) {
      this.ndc.set(0, 0);
      this.ray.setFromCamera(this.ndc, this.d.camera);
      return;
    }
    const r = this.d.canvas.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.d.camera);
  }

  /** Agent under the screen centre (first-person crosshair). */
  aimAgentAtCenter(): Agent | null {
    this.ndc.set(0, 0);
    this.ray.setFromCamera(this.ndc, this.d.camera);
    return this.pickAgent();
  }

  private pickAgent(): Agent | null {
    const agents = [...this.d.office.agents.values()].filter((a) => !a.removed && a.state !== 'fade');
    const hits = this.ray.intersectObjects(
      agents.map((a) => a.rig.root),
      true,
    );
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object;
      while (o && !agents.some((a) => a.rig.root === o)) o = o.parent;
      if (o) return agents.find((a) => a.rig.root === o)!;
    }
    return null;
  }

  private pickDesk(): Desk | null {
    const hits = this.ray.intersectObjects(
      this.d.world.desks.flatMap((dk) => [dk.monitor, dk.chair]),
      true,
    );
    for (const h of hits) {
      const dk = this.d.world.desks.find((dk) => isChild(h.object, dk.monitor) || isChild(h.object, dk.chair));
      if (dk) return dk;
    }
    return null;
  }

  private planeHit(y: number, out: THREE.Vector3) {
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -y);
    return this.ray.ray.intersectPlane(plane, out);
  }

  // ------------------------------------------------------------------ input

  private onDown(e: PointerEvent) {
    if (e.button === 2) {
      this.setRay(e);
      const ag = this.pickAgent();
      if (ag && this.deskOf(ag)) {
        e.stopPropagation();
        this.rightClaimed = true;
        this.spin(ag);
      }
      return;
    }
    if (e.button !== 0) return;
    this.setRay(e);
    const agent = this.pickAgent();
    const claim = () => {
      e.stopPropagation();
      this.d.controls.enabled = false;
    };
    switch (this.tool) {
      case 'hand':
        if (!agent) return;
        claim();
        this.down = { x: e.clientX, y: e.clientY, agent, t: performance.now() };
        this.d.canvas.style.cursor = 'grabbing';
        return;
      case 'slap':
      case 'smack':
        if (!agent) return;
        claim();
        this.down = { x: e.clientX, y: e.clientY, agent: null, t: performance.now() };
        if (this.tool === 'slap') this.slap(agent);
        else this.smack(agent);
        return;
      case 'paper':
      case 'duck':
        claim();
        this.throwAt(agent, this.tool);
        this.down = { x: e.clientX, y: e.clientY, agent: null, t: performance.now() };
        return;
      case 'water':
        claim();
        this.spraying = true;
        this.down = { x: e.clientX, y: e.clientY, agent: null, t: performance.now() };
        return;
      case 'power':
      case 'mug':
      case 'spin':
      case 'chair': {
        const desk = agent ? this.deskOf(agent) : this.pickDesk();
        if (!desk) return;
        claim();
        this.down = { x: e.clientX, y: e.clientY, agent: null, t: performance.now() };
        if (this.tool === 'power') this.togglePower(desk);
        else if (this.tool === 'chair') this.pullChair(desk);
        else if (this.tool === 'mug') this.stealMug(desk);
        else {
          const occ = this.occupantOf(desk);
          if (occ) this.spin(occ);
        }
        return;
      }
    }
  }

  private onMove(e: PointerEvent) {
    if (e.target !== this.d.canvas && !this.dragging && !this.down) {
      this.cursorValid = false;
      return;
    }
    this.setRay(e);
    // cursor point in the room (for eyes that follow it, aiming, dragging)
    this.cursorValid = !!this.planeHit(1.1, this.cursor);
    if (this.tool === 'hand' && !this.down) {
      const a = this.pickAgent();
      if (a !== this.hoverAgent) {
        this.hoverAgent = a;
        this.d.canvas.style.cursor = a ? 'grab' : 'default';
      }
    }
    if (this.down?.agent && !this.dragging) {
      const moved = Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y);
      if (moved > 7) this.startDrag(this.down.agent);
    }
  }

  private cancelGesture() {
    this.down = null;
    this.spraying = false;
    this.d.controls.enabled = true;
    if (this.dragging) {
      const a = this.dragging;
      this.dragging = null;
      a.drop();
    }
  }

  private onUp(e: PointerEvent) {
    if (e.button !== 0) return;
    const down = this.down;
    this.down = null;
    this.spraying = false;
    this.d.controls.enabled = true;
    if (this.tool === 'hand') this.d.canvas.style.cursor = 'grab';
    if (this.dragging) {
      const a = this.dragging;
      this.dragging = null;
      a.drop();
      this.d.sound.whoosh();
      return;
    }
    if (down?.agent && this.tool === 'hand') this.poke(down.agent);
  }

  // ------------------------------------------------------------------ teases

  private bumpAnnoy(a: Agent, n = 1) {
    const v = (this.annoy.get(a.id) ?? 0) + n;
    this.annoy.set(a.id, v);
    return v;
  }

  private emote(a: Agent, k: EmoteKind, dur = 1.5) {
    this.d.emotes.show(this.anchor(a), k, dur);
  }

  private anchors = new Map<string, () => THREE.Vector3>();
  anchor(a: Agent) {
    let f = this.anchors.get(a.id);
    if (!f) {
      const v = new THREE.Vector3();
      f = () => a.headWorld(v);
      this.anchors.set(a.id, f);
    }
    return f;
  }

  private poke(a: Agent) {
    if (a.held || a.falling) return;
    const now = performance.now();
    const list = (this.clicks.get(a.id) ?? []).filter((t) => now - t < 900);
    list.push(now);
    this.clicks.set(a.id, list);
    if (list.length >= 4) {
      // rapid clicks = tickle
      this.bumpAnnoy(a, 0.3);
      if (a.reaction?.name !== 'tickle') {
        a.react(R.tickle());
        this.d.sound.giggle();
      } else a.reaction.dur = Math.max(a.reaction.dur, a.reaction.t + 1.2);
      this.emote(a, 'laugh', 1.4);
      a.say(pick(['hahaha stop!', 'that tickles! 😂', 'hehe no no no']), 'say', 1.6);
      return;
    }
    const level = this.bumpAnnoy(a);
    this.d.sound.boop();
    if (level >= 6) return this.retaliate(a);
    if (level >= 3) {
      a.react(R.annoyed(a));
      this.emote(a, 'anger', 1.8);
      a.say(pick(['Hey! I’m working!', 'Stop poking me 😤', 'Seriously?', 'I can see you…']), 'say', 2);
    } else {
      a.react(R.poked(a));
      this.emote(a, 'exclaim', 1.0);
      if (Math.random() < 0.5) a.say(pick(['!?', 'huh?', 'oh! hi', 'what?']), 'say', 1.2);
    }
  }

  private slap(a: Agent) {
    if (a.held || a.falling) return;
    const at = this.headCenter(a, new THREE.Vector3());
    this.d.sound.slap(at);
    this.d.shake(0.06);
    this.emote(a, 'slap', 0.9);
    setTimeout(() => this.emote(a, 'stars', 1.2), 250);
    const level = this.bumpAnnoy(a, 2);
    a.react(R.slapped(a));
    a.say(pick(['Ow! What was that for?!', 'Did you just slap me?!', 'HR will hear about this!', 'My face! 😳', 'I’m literally coding!']), 'alert', 2);
    if (level >= 6) setTimeout(() => this.retaliate(a, 'slap'), 1300);
  }

  private smack(a: Agent) {
    if (a.held || a.falling) return;
    const at = this.headCenter(a, new THREE.Vector3());
    this.d.sound.smack(at);
    this.emote(a, 'smack', 0.9);
    setTimeout(() => this.emote(a, 'anger', 1.4), 400);
    const level = this.bumpAnnoy(a, 1.5);
    a.react(R.smacked(a));
    a.say(pick(['Hey! My head!', 'Ouch, rude!', 'Was that necessary?', 'I felt that in my code.', 'Stop it! 😠']), 'say', 1.8);
    if (level >= 6) setTimeout(() => this.retaliate(a, 'slap'), 1200);
  }

  private startDrag(a: Agent) {
    if (a.state === 'fade') return;
    this.dragging = a;
    a.pickUp();
    this.d.sound.whoosh();
    this.bumpAnnoy(a, 1.5);
    this.emote(a, 'sweat', 3);
    a.say(pick(['Whoa whoa whoa!', 'Put me down!', 'AAAAH', 'not again…']), 'alert', 2.5);
    a.onLanded = () => {
      a.onLanded = undefined;
      this.d.shake(0.15);
      this.emote(a, 'dizzy', 1.6);
      a.react({
        ...R.landed(a),
        onDone: () => {
          // stay where you were put (or move into the room you were dropped in)
          this.d.office.placed(a.id);
          if ((this.annoy.get(a.id) ?? 0) >= 6) this.retaliate(a);
        },
      });
    };
  }

  private throwAt(agent: Agent | null, kind: 'paper' | 'duck') {
    const cam = this.d.camera;
    const start = cam.position.clone().add(new THREE.Vector3(0.6, -0.8, 0).applyQuaternion(cam.quaternion));
    const target = new THREE.Vector3();
    if (agent) this.headCenter(agent, target);
    else if (!this.planeHit(0, target)) return;
    this.launch(start, target, kind, undefined, 12);
    this.d.sound.whoosh();
  }

  /** Throw with a ballistic arc so it lands on `target`. */
  private launch(start: THREE.Vector3, target: THREE.Vector3, kind: Ball['kind'], from?: Agent, speed = 12) {
    const T = THREE.MathUtils.clamp(start.distanceTo(target) / speed, 0.35, 1.3);
    const vel = target.clone().sub(start).divideScalar(T);
    vel.y += 0.5 * GRAVITY * T;
    const mesh =
      kind === 'paper' ? new THREE.Mesh(this.paperGeo, this.paperMat) : kind === 'drop' ? new THREE.Mesh(this.dropGeo, this.dropMat) : (this.duckProto.clone() as unknown as THREE.Mesh);
    mesh.castShadow = kind !== 'drop';
    mesh.position.copy(start);
    this.d.scene.add(mesh);
    this.balls.push({
      mesh,
      vel,
      spin: new THREE.Vector3(Math.random() * 10, Math.random() * 10, Math.random() * 10).multiplyScalar(kind === 'duck' ? 0.4 : 1),
      life: 0,
      resting: 0,
      from,
      kind,
    });
    if (this.balls.length > 60) this.removeBall(0);
  }

  private headCenter(a: Agent, out: THREE.Vector3) {
    a.rig.joints.head.getWorldPosition(out);
    out.y += 0.22 * a.rig.root.scale.y;
    return out;
  }

  private onHit(a: Agent, b: Ball) {
    if (b.kind === 'drop') {
      const until = this.wetUntil.get(a.id) ?? 0;
      const now = performance.now();
      this.wetUntil.set(a.id, now + 900);
      if (until < now) {
        a.react(R.wet(a));
        this.emote(a, 'sweat', 1.6);
        a.say(pick(['Hey!! My keyboard!', 'It’s raining?!', 'brrr 🥶', 'Not the laptop!']), 'say', 1.8);
        this.bumpAnnoy(a, 1);
        this.d.sound.splash();
      } else if (a.reaction?.name === 'wet') a.reaction.dur = Math.max(a.reaction.dur, a.reaction.t + 0.6);
      if ((this.annoy.get(a.id) ?? 0) >= 7) this.retaliate(a, 'water');
      return;
    }
    const level = this.bumpAnnoy(a, 1.2);
    this.d.sound.bonk();
    if (b.kind === 'duck') {
      this.d.sound.squeak();
      a.react(R.duckHit(a));
      this.emote(a, 'heart', 1.6);
      a.say(pick(['A duck! 🦆', 'aww, quack', 'debugging buddy!']), 'say', 1.8);
      this.annoy.set(a.id, Math.max(0, level - 2)); // ducks calm everyone down
      return;
    }
    a.react(R.bonked(a));
    this.emote(a, 'stars', 1.4);
    if (level >= 5) setTimeout(() => this.retaliate(a), 900);
    else a.say(pick(['Ow!', 'Who threw that?!', 'ouch 😣', 'HEY']), 'say', 1.5);
  }

  /** The agent has had enough: glare and throw something back at the camera. */
  retaliate(a: Agent, kind: 'paper' | 'water' | 'slap' = 'paper') {
    if (a.held || a.falling || a.reaction?.name === 'retaliate') return;
    this.annoy.set(a.id, 1.5);
    this.emote(a, 'anger', 2.2);
    a.say(pick(['THAT’S IT.', 'Take this!', 'Revenge! 😠', 'You asked for it']), 'alert', 2);
    a.react({
      ...R.retaliate(a),
      onTick: (t) => {
        if (t >= 0.6 && !(a as any)._threw) {
          (a as any)._threw = true;
          const hand = a.rig.handR.getWorldPosition(new THREE.Vector3());
          const tgt = this.d.camera.position.clone().add(new THREE.Vector3(0, -0.2, 0));
          if (kind === 'slap') {
            // slaps back at the camera: a red handprint on your screen
            this.d.sound.slap();
            this.d.splat('slap');
          } else if (kind === 'water') for (let i = 0; i < 14; i++) this.launch(hand, tgt.clone().add(rand3(0.4)), 'drop', a, 10);
          else this.launch(hand, tgt, 'paper', a, 10);
          this.d.sound.whoosh();
        }
      },
      onDone: () => ((a as any)._threw = false),
    });
  }

  private deskOf(a: Agent): Desk | null {
    return a.spot?.kind === 'desk' && a.seated ? (a.spot as Desk) : null;
  }

  private occupantOf(desk: Desk): Agent | null {
    const id = desk.occupant;
    const a = id ? this.d.office.agents.get(id) : null;
    return a && a.seated && a.spot === desk ? a : null;
  }

  private togglePower(desk: Desk) {
    if (desk?.kind !== 'desk') return;
    const on = !desk.screen.isOn;
    desk.screen.setPower(on);
    this.d.sound.click();
    const a = this.occupantOf(desk);
    if (!a || on) return;
    this.bumpAnnoy(a, 1.5);
    this.emote(a, 'exclaim', 1.2);
    a.say(pick(['NOOO my work!', 'Did I save?!', 'Wait, what?!', 'Power outage?!']), 'alert', 2);
    a.react({
      ...R.monitorPanic(a),
      onTick: (t) => {
        if (t > 2.3 && !desk.screen.isOn) {
          desk.screen.setPower(true);
          this.d.sound.click();
          this.emote(a, 'sweat', 1.2);
          a.say('phew… 😮‍💨', 'say', 1.4);
        }
      },
    });
  }

  private pullChair(desk: Desk) {
    if (desk?.kind !== 'desk') return;
    const a = this.occupantOf(desk);
    if (!a || a.reaction?.name === 'chair') {
      this.slideChair(desk, 0.55, 0.9);
      return;
    }
    this.bumpAnnoy(a, 2);
    this.slideChair(desk, 0.6, 1.2);
    this.d.sound.whoosh();
    setTimeout(() => {
      this.d.sound.thud();
      this.d.shake(0.12);
      this.emote(a, 'stars', 1.5);
    }, 300);
    a.say(pick(['WHO MOVED MY CHAIR', 'my back… 😩', 'very funny.', 'oof!']), 'alert', 2.2);
    a.react({
      ...R.chairFall(a),
      onDone: () => {
        if ((this.annoy.get(a.id) ?? 0) >= 6) this.retaliate(a);
      },
    });
  }

  private spin(a: Agent) {
    const now = performance.now();
    const again = now - (this.lastSpin.get(a.id) ?? 0) < 1000;
    this.lastSpin.set(a.id, now);
    this.bumpAnnoy(a, 1);
    a.react(R.spinChair(a, again ? 3 : 2));
    this.d.sound.whoosh();
    a.say(again ? 'stop stop STOP 😵' : pick(['wheeee!', 'whoaaa', 'weeee 🌀']), 'say', 1.6);
    setTimeout(() => this.emote(a, 'dizzy', 1.2), 1600);
    if (again) this.emote(a, 'sweat', 1.5);
  }

  private stealMug(desk: Desk) {
    if (desk?.kind !== 'desk') return;
    const a = this.occupantOf(desk);
    const mug = desk.mug;
    if (mug.scale.x < 0.5) return;
    this.d.sound.click();
    this.mugAnims.push({ desk, t: 0, back: a ? 4.0 : 2.5 });
    if (!a) return;
    this.bumpAnnoy(a, 1.5);
    const mugPos = mug.getWorldPosition(new THREE.Vector3());
    setTimeout(() => this.emote(a, 'question', 1.0), 400);
    setTimeout(() => {
      this.emote(a, 'anger', 1.6);
      a.say(pick(['Where’s my coffee?!', 'Give it back ☕', 'I saw that.']), 'say', 2);
    }, 1500);
    setTimeout(() => this.emote(a, 'heart', 1.3), 4100);
    a.react(R.mugStolen(a, mugPos));
  }

  private mugAnims: { desk: Desk; t: number; back: number }[] = [];

  private chairAnims: { desk: Desk; t: number; out: number; hold: number }[] = [];
  private slideChair(desk: Desk, out: number, hold: number) {
    if (!desk?.chair) return;
    this.chairAnims = this.chairAnims.filter((c) => c.desk !== desk);
    this.chairAnims.push({ desk, t: 0, out, hold });
  }

  // ------------------------------------------------------------------ frame

  update(dt: number) {
    // eyes follow the cursor for agents near it
    for (const a of this.d.office.agents.values()) {
      const near = this.cursorValid && Math.hypot(a.position.x - this.cursor.x, a.position.z - this.cursor.z) < 2.6;
      a.lookAt = near && !a.walking ? this.cursor : null;
    }
    // drag target
    if (this.dragging?.removed) this.dragging = null;
    if (this.dragging) {
      const p = new THREE.Vector3();
      if (this.planeHit(1.55, p)) {
        // carry them anywhere: into another room, the game room or out to the yard
        this.d.office.clampToGround(p);
        p.y = 0.45;
        this.dragging.holdAt(p, dt);
      }
    }
    // chairs turn with agents who spin or swivel in them
    for (const dk of this.d.world.desks) {
      if (this.chairAnims.some((c) => c.desk === dk)) continue;
      const occ = this.occupantOf(dk);
      dk.chair.rotation.y = occ ? occ.spinAngle : 0;
    }
    // water spray
    if (this.spraying) {
      this.sprayAcc += dt;
      const cam = this.d.camera;
      while (this.sprayAcc > 0.035) {
        this.sprayAcc -= 0.035;
        const start = cam.position.clone().add(new THREE.Vector3(0.5, -0.7, 0).applyQuaternion(cam.quaternion));
        const tgt = new THREE.Vector3();
        const ag = this.pickAgent();
        if (ag) this.headCenter(ag, tgt);
        else if (!this.planeHit(0, tgt)) break;
        this.launch(start, tgt.add(rand3(0.12)), 'drop', undefined, 14);
      }
      if (Math.random() < dt * 8) this.d.sound.spray();
    }
    // chairs sliding out and back
    for (let i = this.chairAnims.length - 1; i >= 0; i--) {
      const c = this.chairAnims[i];
      c.t += dt;
      const outU = Math.min(1, c.t / 0.22);
      const backU = Math.max(0, Math.min(1, (c.t - c.hold) / 0.5));
      const k = outU * (1 - backU);
      c.desk.chair.position.set(c.desk.chairHome.x, c.desk.chairHome.y, c.desk.chairHome.z + c.out * easeOut(k));
      c.desk.chair.rotation.y = 0.5 * k;
      if (backU >= 1) {
        c.desk.chair.position.copy(c.desk.chairHome);
        c.desk.chair.rotation.y = 0;
        this.chairAnims.splice(i, 1);
      }
    }
    for (let i = this.mugAnims.length - 1; i >= 0; i--) {
      const m = this.mugAnims[i];
      m.t += dt;
      const gone = Math.min(1, m.t / 0.15);
      const back = Math.max(0, Math.min(1, (m.t - m.back) / 0.3));
      const s = back > 0 ? outBack(back) : 1 - gone;
      m.desk.mug.scale.setScalar(Math.max(0.001, s));
      m.desk.mug.visible = s > 0.01;
      if (back >= 1) {
        m.desk.mug.scale.setScalar(1);
        this.mugAnims.splice(i, 1);
      }
    }
    this.updateBalls(dt);
  }

  private updateBalls(dt: number) {
    const agents = [...this.d.office.agents.values()];
    const head = new THREE.Vector3();
    for (let i = this.balls.length - 1; i >= 0; i--) {
      const b = this.balls[i];
      b.life += dt;
      if (b.resting > 0) {
        b.resting += dt;
        if (b.resting > (b.kind === 'duck' ? 12 : 6)) {
          const m = b.mesh.scale.x - dt * 2;
          b.mesh.scale.setScalar(Math.max(0, m));
          if (m <= 0) this.removeBall(i);
        }
        continue;
      }
      b.vel.y -= GRAVITY * dt;
      b.mesh.position.addScaledVector(b.vel, dt);
      b.mesh.rotation.x += b.spin.x * dt;
      b.mesh.rotation.y += b.spin.y * dt;
      b.mesh.rotation.z += b.spin.z * dt;
      const p = b.mesh.position;
      // thrown back at the camera: splat on the screen
      if (b.from) {
        if (p.distanceTo(this.d.camera.position) < 1.3 || b.life > 2.5) {
          if (b.life <= 2.5) {
            this.d.splat(b.kind === 'drop' ? 'water' : 'paper');
            if (b.kind !== 'drop') this.d.sound.bonk();
          }
          this.removeBall(i);
        }
        continue;
      }
      // hit a head?
      let hit = false;
      for (const a of agents) {
        if (a.removed || a.held) continue;
        this.headCenter(a, head);
        if (head.distanceTo(p) < 0.3 * a.rig.root.scale.y) {
          this.onHit(a, b);
          hit = true;
          if (b.kind === 'drop') {
            this.removeBall(i);
          } else {
            const away = p.clone().sub(head).setY(0).normalize();
            b.vel.set(away.x * 1.2, 1.5, away.z * 1.2);
            b.from = undefined;
            b.mesh.position.addScaledVector(away, 0.05);
          }
          break;
        }
      }
      if (hit) continue;
      if (p.y < 0.06) {
        if (b.kind === 'drop') {
          this.removeBall(i);
          continue;
        }
        p.y = 0.06;
        if (b.life < 3 && !b.looked) {
          b.looked = true;
          for (const a of agents) {
            if (a.reaction || a.held || a.walking) continue;
            if (Math.hypot(a.position.x - p.x, a.position.z - p.z) < (b.kind === 'duck' ? 3 : 1.5)) {
              a.react(R.look(a, p.clone()));
              if (b.kind === 'duck' && Math.random() < 0.5) this.emote(a, 'question', 1.1);
            }
          }
        }
        if (Math.abs(b.vel.y) < 0.8) {
          b.resting = 0.001;
          if (b.kind === 'duck') b.mesh.rotation.set(0, b.mesh.rotation.y, 0);
        } else {
          b.vel.y = -b.vel.y * 0.35;
          b.vel.x *= 0.6;
          b.vel.z *= 0.6;
          b.spin.multiplyScalar(0.5);
          if (b.kind === 'duck') this.d.sound.squeak();
        }
      }
      if (b.life > 8) this.removeBall(i);
    }
  }

  private removeBall(i: number) {
    const b = this.balls[i];
    this.d.scene.remove(b.mesh);
    this.balls.splice(i, 1);
  }
}

function isChild(o: THREE.Object3D, parent: THREE.Object3D) {
  for (let x: THREE.Object3D | null = o; x; x = x.parent) if (x === parent) return true;
  return false;
}

function pick<T>(a: T[]) {
  return a[Math.floor(Math.random() * a.length)];
}

function rand3(s: number) {
  return new THREE.Vector3((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
}

function outBack(u: number) {
  const c1 = 1.70158;
  return 1 + (c1 + 1) * Math.pow(u - 1, 3) + c1 * Math.pow(u - 1, 2);
}

function easeOut(u: number) {
  return 1 - Math.pow(1 - u, 3);
}

function makeDuck() {
  const g = new THREE.Group();
  const yellow = new THREE.MeshStandardMaterial({ color: 0xffd23f, roughness: 0.5 });
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.07, 14, 10), yellow);
  body.scale.set(1.2, 0.85, 1);
  g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 10), yellow);
  head.position.set(0.05, 0.07, 0);
  g.add(head);
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.04, 8), new THREE.MeshStandardMaterial({ color: 0xf28a2e }));
  beak.rotation.z = -Math.PI / 2;
  beak.position.set(0.1, 0.065, 0);
  g.add(beak);
  for (const z of [-0.02, 0.02]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.007, 6, 5), new THREE.MeshBasicMaterial({ color: 0x111111 }));
    eye.position.set(0.08, 0.085, z);
    g.add(eye);
  }
  g.traverse((o) => (o.castShadow = true));
  return g;
}
