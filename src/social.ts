// How agents react to the player walking among them (per the Fable design spec).
import * as THREE from 'three';
import type { Office } from './office';
import type { Player } from './player';
import type { Tease } from './tease';
import * as R from './reactions';

interface Memory {
  looking: boolean;
  greetedAt: number;
  hoverStart: number;
  hoverStage: number;
  lastRetaliate: number;
  passAt: number;
  highFiveAsk: number;
}

export class Social {
  private mem = new Map<string, Memory>();
  private head = new THREE.Vector3();

  constructor(
    private office: Office,
    private player: Player,
    private tease: Tease,
  ) {}

  private m(id: string): Memory {
    let x = this.mem.get(id);
    if (!x) this.mem.set(id, (x = { looking: false, greetedAt: -1e9, hoverStart: 0, hoverStage: 0, lastRetaliate: -1e9, passAt: -1e9, highFiveAsk: -1e9 }));
    return x;
  }

  update() {
    if (!this.player.spawned) return;
    const now = performance.now();
    const pp = this.player.position;
    this.player.agent.headWorld(this.head);
    this.head.y -= 0.45;
    for (const a of this.office.agents.values()) {
      if (a.removed || a.held || a.falling) continue;
      const m = this.m(a.id);
      const to = pp.clone().sub(a.position).setY(0);
      const d = to.length();
      const facing = new THREE.Vector3(Math.sin(a.yawAngle), 0, Math.cos(a.yawAngle));
      const inView = d < 0.01 || to.normalize().dot(facing) > -0.2;

      // look at the player (with hysteresis); busy typists only glance now and then
      if (m.looking ? d > 3.6 : d < 3.0 && inView) m.looking = !m.looking;
      const typing = a.busyWorking && a.seated && (a.activity?.kind === 'write' || a.activity?.kind === 'todo');
      const glance = !typing || d < 1.0 || (now + a.quirks.seed * 8000) % 8000 < 1200;
      if (m.looking && glance && !a.lookAt) a.lookAt = this.head;

      // first greeting when you come close
      if (d < 2.2 && now - m.greetedAt > 90000 && !a.reaction) {
        m.greetedAt = now;
        if (a.busyWorking && a.seated) {
          a.react(R.nod(a, pp.clone()));
          a.say(pick(['Hi! Bit busy…', 'Oh, hey!', 'hi! 👋']), 'say', 1.8);
        } else if (!a.walking) {
          a.react(R.waveBack(a, pp.clone()));
          a.say(pick(['Hey, welcome!', 'Oh hi!', "Look who's here", 'o/']), 'say', 2);
        }
      }

      // celebrating agents want a high five
      if (a.state === 'celebrate' && d < 2.5 && now - m.highFiveAsk > 8000) {
        m.highFiveAsk = now;
        a.say('High five? ✋ (press E)', 'say', 3);
      }

      // passing walkers
      if (a.walking && d < 0.8 && now - m.passAt > 20000) {
        m.passAt = now;
        if (Math.random() < 0.15) a.say('Excuse me!', 'say', 1.2);
      }

      // hovering right behind someone who is working
      if (a.busyWorking && a.seated && a.spot?.kind === 'desk') {
        const behind = pp.distanceTo(a.position) < 0.8;
        if (behind) {
          if (!m.hoverStart) m.hoverStart = now;
          const s = (now - m.hoverStart) / 1000;
          if (s > 6 && m.hoverStage < 1) {
            m.hoverStage = 1;
            this.office.emote(a, 'question', 1.4);
            a.react(R.waveBack(a, pp.clone()));
            a.say('Can I help you?', 'say', 2.4);
          } else if (s > 12 && m.hoverStage < 2) {
            m.hoverStage = 2;
            this.office.emote(a, 'sweat', 1.4);
            a.say('…you’re hovering.', 'say', 2.4);
          } else if (s > 20 && m.hoverStage < 3 && now - m.lastRetaliate > 30000) {
            m.hoverStage = 3;
            m.lastRetaliate = now;
            a.say('Personal space, please.', 'alert', 2.4);
            this.tease.retaliate(a);
          }
        } else if (pp.distanceTo(a.position) > 1.2) {
          m.hoverStart = 0;
          m.hoverStage = 0;
        }
      }
    }
  }
}

function pick<T>(a: T[]) {
  return a[Math.floor(Math.random() * a.length)];
}
