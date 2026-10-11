// The Stage implementation: owns the characters, assigns desks and seats, and plans their moves.
import * as THREE from 'three';
import { Agent, type Action } from './agent';
import { variantFor } from './character';
import { hex } from './palette';
import { modelLabel, type Activity, type AskPayload, type SpawnOptions, type Stage } from './types';
import type { Desk, Spot, World } from './world';
import type { Effects } from './effects';
import type { Sound } from './sound';
import type { Emotes, EmoteKind } from './emotes';
import * as R from './reactions';
import { trimShadowCasters } from './perf';
import { pickName } from './names';

const tmp = new THREE.Vector3();

export function verb(a: Activity): string {
  const d = a.detail ?? '';
  switch (a.kind) {
    case 'think':
      return d ? `“${d}”` : 'Thinking…';
    case 'read':
      return `Reading ${d}`;
    case 'write':
      return `${a.tool === 'Write' ? 'Writing' : 'Editing'} ${d}`;
    case 'run':
      return `$ ${d}`;
    case 'search':
      return `Searching ${d}`;
    case 'web':
      return a.tool === 'WebSearch' ? `Web search: ${d}` : `Browsing ${d}`;
    case 'delegate':
      return `Delegating: ${d}`;
    case 'todo':
      return 'Updating the plan';
    case 'mcp':
      return `Using ${d || a.tool}`;
    default:
      return `${a.tool ?? 'Working'} ${d}`.trim();
  }
}

export class Office implements Stage {
  readonly agents = new Map<string, Agent>();
  private target = new Map<string, Spot | null>(); // where each agent is heading
  private sessionDesk = new Map<string, number>();
  private steamTimer = 0;
  private resumeFn = new Map<string, () => void>();
  private typeTimers = new Map<string, number>();
  private wasNearDoor = false;
  private coffeeTimer = 12;
  private voiceAt = new Map<string, number>();
  private anchors = new Map<string, () => THREE.Vector3>();
  emotes?: Emotes;
  onChange?: () => void;
  onFollowRemoved?: (id: string) => void;

  constructor(
    private scene: THREE.Scene,
    private world: World,
    private fx: Effects,
    private sound: Sound,
  ) {}

  has(id: string) {
    return this.agents.has(id);
  }

  spawn(id: string, o: SpawnOptions) {
    if (this.agents.has(id)) return;
    // every agent gets an Iranian first name; the character's look follows the name
    const taken = new Set([...this.agents.values()].map((x) => x.name));
    const nm = o.fixedName
      ? { name: o.fixedName, gender: o.gender ?? ('m' as const) }
      : o.role === 'player'
        ? { name: o.name, gender: 'm' as const }
        : pickName(o.role === 'lead' ? o.session : id + o.session, taken);
    const a = new Agent(id, o.role, variantFor(o.role, id), o.session, nm.name, o.subtitle, nm.gender);
    trimShadowCasters(a.rig.root);
    this.scene.add(a.rig.root);
    this.agents.set(id, a);
    a.emote = (k, d) => this.emote(a, k, d);
    a.sound = (k) => (k === 'thud' ? this.sound.thud(a.position.clone()) : undefined);
    a.onEvent = (e) => {
      if (e !== 'step') return;
      const p = a.position;
      const onRug = p.x > -6.4 && p.x < -3.8 && p.z > 0.1 && p.z < 3.1;
      this.sound.step(p.clone(), onRug, a.role === 'sub' ? 0.7 : 0.85);
    };
    a.onSay = (text, tone) => {
      // tool bubbles change constantly: only real lines get a voice, and not too often per agent
      if (tone === 'tool' || a.muteBabble) return;
      const now = performance.now();
      if (now - (this.voiceAt.get(a.id) ?? 0) < 700) return;
      this.voiceAt.set(a.id, now);
      this.sound.voice(text, a.voicePitch, a.headWorld(new THREE.Vector3()).setY(a.position.y + 1.1), tone === 'alert' ? 'alert' : tone === 'think' ? 'think' : 'say');
    };
    this.target.set(id, null);
    if (o.instant) {
      const spot = this.pickLounge(a);
      this.teleport(a, spot, 'rest');
    } else {
      a.place(this.world.doorOut, Math.PI / 2);
      a.say(o.role === 'sub' ? 'hi! 👋' : `Hi! ${o.subtitle}`, 'say', 2.5);
      this.sound.pop(this.world.doorIn.clone().setY(1));
      a.popIn();
      this.moveTo(a, this.pickLounge(a), [{ kind: 'rest' }], [], true);
    }
    this.onChange?.();
  }

  work(id: string, instant: boolean) {
    const a = this.agents.get(id);
    if (!a) return;
    const t = this.target.get(id);
    if (t && (t.kind === 'desk' || t.kind === 'board')) return; // already there or on the way
    const spot = this.pickDesk(a);
    if (instant) this.teleport(a, spot, spot.kind === 'desk' ? 'work' : 'rest');
    else this.moveTo(a, spot, [{ kind: spot.kind === 'desk' ? 'work' : 'rest' }], [], true);
    this.onChange?.();
  }

  activity(id: string, act: Activity) {
    const a = this.agents.get(id);
    if (!a) return;
    const thoughtFor = a.activity?.kind === 'think' ? performance.now() - a.activitySince : 0;
    a.setActivity(act);
    if (thoughtFor > 4000 && act.kind !== 'think' && a.seated && !a.reaction && Math.random() < 0.7) {
      a.react(R.lightbulb());
      this.emote(a, 'bulb', 1.4);
    }
    a.say(verb(act), act.kind === 'think' ? 'think' : 'tool', act.kind === 'think' ? 6 : 3.5);
    const desk = this.deskOf(a);
    if (desk && a.seated) desk.screen.setActivity(act);
    if (act.kind === 'delegate' && desk) desk.screen.subagents = this.subsOf(a.session);
    this.onChange?.();
  }

  toolDone(id: string, failed = false) {
    const a = this.agents.get(id);
    if (!a) return;
    a.toolDoneAt = performance.now();
    if (failed && a.seated && a.spot?.kind === 'desk' && !a.reaction) {
      a.react(R.facepalm());
      this.emote(a, 'sweat', 1.8);
      a.say(Math.random() < 0.5 ? 'ugh, that failed…' : 'hmm, error 😩', 'say', 2);
    }
    const desk = this.deskOf(a);
    if (desk && a.seated) {
      setTimeout(() => {
        if (a.toolDoneAt && performance.now() - a.toolDoneAt >= 2400 && a.seated && this.deskOf(a) === desk)
          desk.screen.setActivity({ kind: 'think' });
      }, 2500);
    }
  }

  idle(id: string, mood: 'happy' | 'sad', instant: boolean) {
    const a = this.agents.get(id);
    if (!a) return;
    const t = this.target.get(id);
    if (t && (t.kind === 'couch' || t.kind === 'stand') && !a.busyWorking) return;
    a.setActivity(null);
    const spot = this.pickLounge(a);
    if (instant) return this.teleport(a, spot, 'rest');
    const pre: Partial<Action>[] = [];
    if (mood === 'happy') {
      if (Math.random() < 0.55) pre.push(this.celebrateAction(a));
      else pre.push({ kind: 'stretch', dur: 1.6 });
      a.say(Math.random() < 0.5 ? 'Done! ✨' : 'All set!', 'say', 3);
    } else {
      a.say('Hmm, that failed…', 'say', 3);
    }
    this.moveTo(a, spot, [{ kind: 'rest' }], pre, true);
    this.onChange?.();
  }

  leave(id: string, celebrate: boolean, instant: boolean) {
    const a = this.agents.get(id);
    if (!a) return;
    if (instant) return this.remove(a);
    a.setActivity(null);
    const pre: Partial<Action>[] = [];
    if (celebrate) {
      pre.push(this.celebrateAction(a));
      a.say('Task complete! 🎉', 'say', 3);
    }
    this.markSubDone(a);
    this.moveTo(a, null, [{ kind: 'fade', dur: 0.6, onStart: () => a.say('bye!', 'say', 1.5), onDone: () => this.remove(a) }], pre, true, 'DOOR_OUT');
    this.onChange?.();
  }

  notify(id: string, text: string) {
    const a = this.agents.get(id);
    if (!a) return;
    a.notifying = true;
    a.say(text, 'alert', 10);
    this.sound.ding(a.position.clone().setY(1.3));
    const desk = this.deskOf(a);
    if (desk && a.seated) desk.screen.setActivity(null, true);
    this.onChange?.();
  }

  setModel(id: string, model: string) {
    const a = this.agents.get(id);
    const label = modelLabel(model);
    if (!a || a.model === label) return;
    a.model = label;
    this.onChange?.();
  }

  private asks = new Map<string, string>(); // askId -> character id
  onAsk?: (a: Agent) => void;

  ask(id: string, ask: AskPayload) {
    const a = this.agents.get(id);
    if (!a) return;
    this.asks.set(ask.id, id);
    a.pendingAsk = ask;
    a.notifying = true; // raise a hand
    a.say((ask.type === 'permission' ? '🔐 ' : '❓ ') + ask.summary, 'alert', 600);
    this.emote(a, ask.type === 'permission' ? 'exclaim' : 'question', 2);
    this.sound.ding(a.position.clone().setY(1.3));
    this.onAsk?.(a);
    this.onChange?.();
  }

  clearAsk(askId: string, how: string) {
    const id = this.asks.get(askId);
    this.asks.delete(askId);
    const a = id ? this.agents.get(id) : undefined;
    if (!a || a.pendingAsk?.id !== askId) return;
    a.pendingAsk = null;
    a.notifying = false;
    if (a.bubble?.tone === 'alert') a.bubble.until = performance.now();
    if (how === 'answered') {
      a.say(pick(['Thanks! 🙏', 'Got it, thank you!', 'Perfect, thanks!']), 'say', 2);
      this.emote(a, 'heart', 1.4);
    }
    this.onChange?.();
  }

  /** Bring a team member into the office (if not here yet). Returns its character id. */
  callMember(memberId: string, o: { name: string; gender: 'm' | 'f'; subtitle: string; model: string }): string {
    const id = 'team:' + memberId;
    let a = this.agents.get(id);
    if (!a) {
      this.spawn(id, { role: 'lead', name: o.name, subtitle: o.subtitle, session: id, instant: false, fixedName: o.name, gender: o.gender });
      a = this.agents.get(id)!;
    }
    a.subtitle = o.subtitle;
    if (o.model) a.model = o.model;
    this.onChange?.();
    return id;
  }

  /** Team members who are no longer on the team go home. */
  dismissMember(memberId: string) {
    const id = 'team:' + memberId;
    if (this.agents.has(id)) this.leave(id, false, false);
  }

  /** Call a new agent to the manager desk. Resolves with its id once it stands in front of you. */
  summon(runId: string, project: string, model: string): Promise<string> {
    const id = 'run:' + runId;
    const name = project.split(/[\\/]/).filter(Boolean).pop() ?? project;
    return new Promise((resolve) => {
      this.spawn(id, { role: 'lead', name: 'Agent', subtitle: name, session: 'run:' + runId, instant: false });
      const a = this.agents.get(id)!;
      if (model) a.model = model;
      a.say(pick(['Coming, boss!', 'On my way!', 'You rang?']), 'say', 2);
      const spot = this.world.manager.visitors.find((s) => !s.occupant) ?? this.world.manager.visitors[1];
      let done = false;
      const arrive = () => {
        if (done) return;
        done = true;
        resolve(id);
      };
      this.moveTo(a, spot, [{ kind: 'rest', onStart: arrive }], [], true);
      setTimeout(arrive, 20000);
    });
  }

  report(id: string, ok: boolean, summary: string) {
    const a = this.agents.get(id);
    if (!a) return;
    a.setActivity(null);
    const spot = this.world.manager.visitors.find((s) => !s.occupant || s.occupant === id) ?? this.world.manager.visitors[0];
    const short = summary.replace(/\s+/g, ' ').trim();
    const pre: Partial<Action>[] = [];
    this.moveTo(
      a,
      spot,
      [
        ok ? this.celebrateAction(a) : { kind: 'stretch', dur: 1.6 },
        {
          kind: 'rest',
          dur: 6,
          onStart: () => {
            a.say((ok ? 'Done! ' : 'Hmm… ') + (short.length > 90 ? short.slice(0, 89) + '…' : short), 'say', 6.5);
            if (!ok) this.emote(a, 'sweat', 2);
          },
          // team members stay in the office between tasks; one-off helpers go home
          onDone: () => (id.startsWith('team:') ? this.moveTo(a, this.pickLounge(a), [{ kind: 'rest' }], [], true) : this.leave(id, false, false)),
        },
      ],
      pre,
      true,
    );
    this.onChange?.();
  }

  rename(id: string, _name: string, subtitle: string) {
    const a = this.agents.get(id);
    if (!a) return;
    a.subtitle = subtitle; // names stay Iranian; the role (Explore, Plan…) becomes the subtitle
    this.onChange?.();
  }

  // ------------------------------------------------------------------------ planning

  private celebrateAction(a: Agent): Partial<Action> {
    return {
      kind: 'celebrate',
      dur: 2.2,
      onStart: () => {
        this.fx.confetti(a.headWorld(tmp).clone().setY(1.4));
        this.sound.chime(a.position.clone().setY(1.2));
      },
    };
  }

  /** Stand up (if seated), run `pre`, walk to the spot (or node), sit/turn, then `after`. */
  private moveTo(a: Agent, spot: Spot | null, after: Partial<Action>[], pre: Partial<Action>[], replan: boolean, node?: string) {
    const old = a.spot;
    const prevTarget = this.target.get(a.id);
    if (prevTarget && prevTarget !== spot && prevTarget !== old && prevTarget.occupant === a.id) prevTarget.occupant = undefined;
    if (spot) spot.occupant = a.id;
    this.target.set(a.id, spot);

    const release = () => {
      if (old && old !== spot && old.occupant === a.id) this.releaseSpot(old);
    };
    const actions: Partial<Action>[] = [];
    const wasSeated = a.seated && old;
    if (wasSeated && old) {
      if (old === spot) {
        // already sitting here: just switch activity
        (replan ? a.plan.bind(a) : a.enqueue.bind(a))(after);
        return;
      }
      actions.push({ kind: 'stand', dur: 0.8, to: this.standPoint(old), toYaw: old.yaw, onDone: release });
    } else release();
    actions.push(...pre);

    const walk: Partial<Action> = { kind: 'walk', path: [] };
    walk.onStart = () => {
      a.spot = spot;
      walk.path = this.route(a, wasSeated ? old : null, spot, node);
    };
    actions.push(walk);
    if (spot) {
      if (spot.kind === 'desk' || spot.kind === 'couch') {
        actions.push({
          kind: 'sit',
          dur: 0.9,
          onStart: () => this.sound.chair(spot.pos.clone().setY(0.5)),
          to: spot.pos,
          toYaw: spot.yaw,
          onDone: () => {
            if (spot.kind === 'desk') this.arriveDesk(a, spot as Desk);
          },
        });
      } else {
        actions.push({ kind: 'turn', dur: 0.35, toYaw: spot.yaw, onDone: () => spot.node === 'COFFEE' && this.sound.coffee(this.world.coffeeSteam) });
      }
    }
    actions.push(...after);
    this.resumeFn.set(a.id, () =>
      this.moveTo(
        a,
        spot,
        after.map((x) => ({ ...x })),
        [],
        true,
        node,
      ),
    );
    if (replan) a.plan(actions);
    else a.enqueue(actions);
  }

  chairCircles() {
    return this.world.desks.map((d) => {
      const p = d.chair.getWorldPosition(new THREE.Vector3());
      return { x: p.x, z: p.z, r: 0.25 };
    });
  }

  /** Send an agent back to whatever its live session needs (after being dragged around). */
  resume(id: string) {
    const a = this.agents.get(id);
    if (!a || a.removed) return;
    this.resumeFn.get(id)?.();
  }

  emote(a: Agent, k: EmoteKind, dur = 1.5) {
    let f = this.anchors.get(a.id);
    if (!f) {
      const v = new THREE.Vector3();
      f = () => a.headWorld(v);
      this.anchors.set(a.id, f);
    }
    this.emotes?.show(f, k, dur);
  }

  private route(a: Agent, from: Spot | null, spot: Spot | null, node?: string) {
    const pts: THREE.Vector3[] = [];
    if (from) {
      // retrace the old spot's approach back to the corridor
      const back = from.approach.slice(0, -1).reverse();
      if (from.kind !== 'desk' && from.kind !== 'couch') back.length = 0;
      pts.push(...back.map((p) => p.clone()));
    }
    const startPos = pts.length ? pts[pts.length - 1] : a.position;
    const path = this.world.pathTo(startPos, spot, node);
    // drop a first node that lies behind us (avoids walking back to a node we just passed)
    if (path.length > 1 && !from) {
      const d0 = startPos.distanceTo(path[0]);
      const d01 = path[0].distanceTo(path[1]);
      const d1 = startPos.distanceTo(path[1]);
      if (d1 < d01 && d0 < d01) path.shift();
    }
    pts.push(...path);
    if (spot && spot.kind !== 'desk' && spot.kind !== 'couch') pts.push(spot.pos.clone());
    return pts;
  }

  private standPoint(s: Spot) {
    if (s.kind === 'desk') return (s as Desk).side;
    if (s.kind === 'couch') return s.approach[0];
    return s.pos;
  }

  private teleport(a: Agent, spot: Spot, then: 'work' | 'rest') {
    if (a.spot && a.spot !== spot && a.spot.occupant === a.id) this.releaseSpot(a.spot);
    spot.occupant = a.id;
    a.spot = spot;
    this.target.set(a.id, spot);
    a.place(spot.pos, spot.yaw);
    a.seated = spot.kind === 'desk' || spot.kind === 'couch';
    a.plan([{ kind: then }]);
    this.resumeFn.set(a.id, () => this.moveTo(a, spot, [{ kind: then }], [], true));
    if (spot.kind === 'desk') this.arriveDesk(a, spot as Desk);
  }

  private arriveDesk(a: Agent, desk: Desk) {
    (desk.mug.material as THREE.MeshStandardMaterial).color.setHex(a.rig.accent);
    desk.screen.setActivity(a.activity ?? { kind: 'think' }, a.notifying);
    if (a.role === 'lead') this.sessionDesk.set(a.session, desk.index);
    this.onChange?.();
  }

  private releaseSpot(s: Spot) {
    s.occupant = undefined;
    if (s.kind === 'desk') {
      const d = s as Desk;
      d.screen.setActivity(null);
      (d.mug.material as THREE.MeshStandardMaterial).color.setHex(0xfaf7f2);
    }
  }

  private pickDesk(a: Agent): Spot {
    const desks = this.world.desks;
    const free = (d: Spot) => !d.occupant || d.occupant === a.id;
    const last = this.sessionDesk.get(a.session);
    if (a.role === 'lead' && last !== undefined && free(desks[last])) return desks[last];
    const order = a.role === 'lead' ? [0, 1, 2, 3, 4, 5, 6, 7] : [4, 5, 6, 7, 0, 1, 2, 3];
    // subagents like to sit near their lead
    if (a.role === 'sub') {
      const lead = this.agents.get(`lead:${a.session}`);
      const ld = lead && this.deskOf(lead);
      if (ld) order.sort((i, j) => Math.abs(desks[i].pos.x - ld.pos.x) - Math.abs(desks[j].pos.x - ld.pos.x) + (i < 4 ? 0.5 : 0) - (j < 4 ? 0.5 : 0));
    }
    for (const i of order) if (free(desks[i])) return desks[i];
    return this.world.boards.find(free) ?? this.world.lounge.find(free) ?? this.world.boards[0];
  }

  private pickLounge(a: Agent): Spot {
    const free = (s: Spot) => !s.occupant || s.occupant === a.id;
    const couches = this.world.lounge.filter((s) => s.kind === 'couch' && free(s));
    if (couches.length) return couches[Math.floor(Math.random() * couches.length)];
    return this.world.lounge.find(free) ?? this.world.boards.find(free) ?? this.world.lounge[3];
  }

  private deskOf(a: Agent): Desk | undefined {
    return a.spot?.kind === 'desk' ? (a.spot as Desk) : undefined;
  }

  private subsOf(session: string) {
    return [...this.agents.values()]
      .filter((x) => x.role === 'sub' && x.session === session)
      .map((x) => ({ name: `${x.name} · ${x.subtitle}`, done: x.state === 'fade' }));
  }

  private markSubDone(a: Agent) {
    if (a.role !== 'sub') return;
    const lead = this.agents.get(`lead:${a.session}`);
    const d = lead && this.deskOf(lead);
    if (d) {
      const item = d.screen.subagents.find((s) => s.name.startsWith(a.name));
      if (item) item.done = true;
    }
  }

  private remove(a: Agent) {
    if (a.removed) return;
    a.removed = true;
    if (a.spot && a.spot.occupant === a.id) this.releaseSpot(a.spot);
    const t = this.target.get(a.id);
    if (t && t.occupant === a.id) this.releaseSpot(t);
    this.scene.remove(a.rig.root);
    this.agents.delete(a.id);
    this.target.delete(a.id);
    this.resumeFn.delete(a.id);
    this.anchors.delete(a.id);
    this.onFollowRemoved?.(a.id);
    this.onChange?.();
  }

  // ------------------------------------------------------------------------ frame

  update(dt: number, g: number) {
    let nearDoor = false;
    let typing = 0;
    for (const a of this.agents.values()) {
      a.update(dt, g);
      const p = a.position;
      if (Math.hypot(p.x + 7, p.z - 3.5) < 1.7 && a.walking) nearDoor = true;
      if (a.busyWorking && a.seated && (a.activity?.kind === 'write' || a.activity?.kind === 'search')) typing++;
    }
    this.world.update(dt, g, nearDoor);
    if (nearDoor !== this.wasNearDoor) {
      this.wasNearDoor = nearDoor;
      this.sound.door(nearDoor, new THREE.Vector3(-7, 1.2, 3.5));
    }
    this.coffeeTimer -= dt;
    if (this.coffeeTimer <= 0) {
      this.coffeeTimer = 20 + Math.random() * 30;
      if (Math.random() < 0.5) this.sound.coffee(this.world.coffeeSteam);
      else this.sound.birds(new THREE.Vector3(3.2, 2, -5));
    }
    for (const a of this.agents.values()) {
      const kind = a.activity?.kind;
      if (!(a.busyWorking && a.seated && !a.reaction)) continue;
      const intensity = kind === 'write' || kind === 'todo' ? 1 : kind === 'search' || kind === 'other' ? 0.6 : kind === 'run' ? 0.4 : kind === 'read' || kind === 'web' ? 0.2 : 0.05;
      const rate = (5 + 6 * intensity) * intensity; // keys per second
      let t = (this.typeTimers.get(a.id) ?? 0) - dt;
      if (t <= 0) {
        t = -Math.log(1 - Math.random()) / Math.max(rate, 0.01);
        this.sound.key(a.position.clone().setY(0.85));
      }
      this.typeTimers.set(a.id, t);
    }
    this.fx.update(dt);

    this.steamTimer -= dt;
    if (this.steamTimer <= 0) {
      this.steamTimer = 0.45;
      if (Math.random() < 0.5) this.fx.steam(this.world.coffeeSteam);
      for (const d of this.world.desks) {
        const occ = d.occupant && this.agents.get(d.occupant);
        if (occ && occ.seated && Math.random() < 0.12) this.fx.steam(d.steamAt);
      }
    }
    void typing;
  }

  boardItems() {
    const items: { name: string; text: string; color: string; done?: boolean }[] = [];
    const leads = [...this.agents.values()].filter((a) => a.role === 'lead');
    for (const l of leads) {
      const text = l.busyWorking || l.walking ? (l.activity ? verb(l.activity) : 'thinking') : 'on a break ☕';
      items.push({ name: l.model ? `${l.name} · ${l.model}` : l.name, text, color: hex(l.rig.accent), done: !l.busyWorking && !l.walking });
      for (const s of this.agents.values())
        if (s.role === 'sub' && s.session === l.session) items.push({ name: `  ↳ ${s.name}${s.model ? ' · ' + s.model : ''}`, text: s.activity ? verb(s.activity) : s.subtitle, color: hex(s.rig.accent) });
    }
    return items;
  }
}

function pick<T>(a: T[]) {
  return a[Math.floor(Math.random() * a.length)];
}
