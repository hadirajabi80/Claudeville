// HTML overlay: name tags and speech bubbles over characters, session panel, event log, controls.
import * as THREE from 'three';
import type { Agent } from './agent';
import type { OfficeEvent } from './types';
import { hex } from './palette';
import { verb } from './office';

const v = new THREE.Vector3();

interface TagEl {
  root: HTMLDivElement;
  bubble: HTMLDivElement;
  name: HTMLDivElement;
  lastBubble: string;
}

export type ConnState = 'connecting' | 'live' | 'offline';

const EVENT_COLORS: Record<string, string> = {
  PreToolUse: '#D97757',
  PostToolUse: '#8FA98A',
  PostToolUseFailure: '#E05D5D',
  UserPromptSubmit: '#6FA8DC',
  SubagentStart: '#B48EDB',
  SubagentStop: '#B48EDB',
  Stop: '#39A853',
  Notification: '#F2B84B',
  SessionStart: '#9CA3AF',
  SessionEnd: '#9CA3AF',
};

export class Hud {
  private tags = new Map<string, TagEl>();
  private layer = document.getElementById('labels')!;
  private sessionsEl = document.getElementById('sessions')!;
  private logEl = document.getElementById('log')!;
  private statusEl = document.getElementById('status')!;
  private countsEl = document.getElementById('counts')!;
  onFollow?: (id: string | null) => void;
  onTalk?: (id: string) => void;
  talkableId: string | null = null;
  followId: string | null = null;

  setConn(s: ConnState, extra = '') {
    this.statusEl.className = `status ${s}`;
    this.statusEl.querySelector('span')!.textContent =
      s === 'live' ? `Connected to Claude Code${extra}` : s === 'connecting' ? 'Connecting…' : 'Bridge offline (run npm run dev)';
  }

  log(e: OfficeEvent, demo = false) {
    const row = document.createElement('div');
    row.className = 'row';
    const time = new Date(e.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const who = e.agentId ? '↳' : '';
    const what = [e.tool, e.detail].filter(Boolean).join(' ');
    row.innerHTML = `<span class="t">${time}</span><span class="k" style="color:${EVENT_COLORS[e.kind] ?? '#999'}">${who}${e.kind}</span><span class="d"></span>`;
    (row.querySelector('.d') as HTMLSpanElement).textContent = (demo ? '[demo] ' : '') + what;
    this.logEl.appendChild(row);
    while (this.logEl.children.length > 60) this.logEl.firstChild!.remove();
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  renderPanel(agents: Agent[], stats: { sessions: number; working: number; subagents: number }) {
    this.countsEl.textContent = `${stats.sessions} session${stats.sessions === 1 ? '' : 's'} · ${stats.working} working · ${stats.subagents} subagent${stats.subagents === 1 ? '' : 's'}`;
    const leads = agents.filter((a) => a.role === 'lead');
    if (!leads.length) {
      this.sessionsEl.innerHTML = `<div class="empty">No agents yet. Start or continue a Claude Code session, or press <b>Demo</b>.</div>`;
      return;
    }
    const html: string[] = [];
    for (const l of leads) {
      html.push(this.rowHtml(l, false));
      for (const s of agents) if (s.role === 'sub' && s.session === l.session) html.push(this.rowHtml(s, true));
    }
    this.sessionsEl.innerHTML = html.join('');
    this.sessionsEl.querySelectorAll<HTMLDivElement>('[data-id]').forEach((el) => {
      el.onclick = () => this.follow(el.dataset.id === this.followId ? null : el.dataset.id!);
    });
    this.sessionsEl.querySelectorAll<HTMLButtonElement>('[data-talk]').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        this.onTalk?.(b.dataset.talk!);
      };
    });
  }

  private rowHtml(a: Agent, sub: boolean) {
    const state = a.notifying ? 'waiting' : a.busyWorking || (a.state === 'sit' && a.spot?.kind === 'desk') ? 'working' : a.walking ? 'walking' : a.state === 'celebrate' ? 'done!' : 'break';
    const doing = a.activity && a.busyWorking ? esc(verb(a.activity)) : '';
    return `<div class="sess ${sub ? 'sub' : ''} ${this.followId === a.id ? 'followed' : ''}" data-id="${a.id}">
      <i style="background:${hex(a.rig.accent)}"></i>
      <div class="who"><b>${sub ? '↳ ' : ''}${esc(a.name)}</b>${a.model ? ` <span class="mdl">${esc(a.model)}</span>` : ''} <small>${esc(a.subtitle)}</small><div class="doing">${doing}</div></div>
      <span class="chip ${state}">${state}</span><button class="talk" data-talk="${a.id}" title="Chat with ${esc(a.name)}">💬</button></div>`;
  }

  follow(id: string | null) {
    this.followId = id;
    this.onFollow?.(id);
    this.sessionsEl.querySelectorAll<HTMLDivElement>('[data-id]').forEach((el) => el.classList.toggle('followed', el.dataset.id === id));
  }

  /** Position tags each frame. */
  update(agents: Iterable<Agent>, camera: THREE.Camera, w: number, h: number) {
    const now = performance.now();
    const seen = new Set<string>();
    for (const a of agents) {
      seen.add(a.id);
      let t = this.tags.get(a.id);
      if (!t) t = this.makeTag(a);
      a.headWorld(v);
      const dist = v.distanceTo(camera.position);
      v.project(camera);
      if (v.z > 1) {
        t.root.style.display = 'none';
        continue;
      }
      t.root.style.display = '';
      const x = (v.x * 0.5 + 0.5) * w;
      const y = (-v.y * 0.5 + 0.5) * h;
      t.root.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      t.root.style.zIndex = String(1000 - Math.round(dist * 10));
      t.root.style.opacity = a.removed ? '0' : dist > 17 ? '0.65' : '1';
      const label = a.role === 'player' ? `★ ${a.name}` : `${a.role === 'sub' ? '↳ ' : ''}${a.name}`;
      if (t.name.dataset.v !== label + a.subtitle + a.model) {
        t.name.dataset.v = label + a.subtitle + a.model;
        t.name.innerHTML = `${esc(label)}${a.model ? `<span class="mdl">${esc(a.model)}</span>` : ''}<small>${esc(a.subtitle)}</small>`;
      }
      t.root.classList.toggle('lead', a.role === 'lead');
      t.root.classList.toggle('player', a.role === 'player');
      t.root.classList.toggle('followed', this.followId === a.id);
      t.root.classList.toggle('talkable', this.talkableId === a.id);
      const b = a.bubble && a.bubble.until > now ? a.bubble : null;
      const key = b ? b.tone + b.text : '';
      if (key !== t.lastBubble) {
        t.lastBubble = key;
        if (b) {
          t.bubble.textContent = b.text.length > 64 ? b.text.slice(0, 63) + '…' : b.text;
          t.bubble.className = `bubble ${b.tone} show`;
        } else t.bubble.className = 'bubble';
      }
    }
    for (const [id, t] of this.tags)
      if (!seen.has(id)) {
        t.root.remove();
        this.tags.delete(id);
      }
  }

  private makeTag(a: Agent): TagEl {
    const root = document.createElement('div');
    root.className = 'tag';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    const name = document.createElement('div');
    name.className = 'name';
    name.style.setProperty('--accent', hex(a.rig.accent));
    name.onclick = () => this.follow(this.followId === a.id ? null : a.id);
    const talk = document.createElement('button');
    talk.className = 'talkpill';
    talk.innerHTML = '<kbd>T</kbd> talk 💬';
    talk.onclick = (e) => {
      e.stopPropagation();
      this.onTalk?.(a.id);
    };
    root.append(bubble, name, talk);
    this.layer.appendChild(root);
    const t = { root, bubble, name, lastBubble: '' };
    this.tags.set(a.id, t);
    return t;
  }
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
