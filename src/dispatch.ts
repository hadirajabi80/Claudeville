// The manager's dispatch panel: pick a model and a project, write a task, ring the bell.
// A new agent walks in, takes the task, works at a desk (a real `claude -p` run), then reports back.
import type { Office } from './office';
import type { Director } from './director';
import type { World } from './world';
import type { Sound } from './sound';
import type { OfficeEvent } from './types';
import { hex } from './palette';
import { modelLabel } from './types';

interface Entry {
  runId: string;
  charId: string;
  name: string;
  color: string;
  model: string;
  project: string;
  task: string;
  status: 'coming' | 'running' | 'done' | 'failed' | 'stopped';
  startedAt: number;
  endedAt?: number;
  result?: string;
  cost?: number;
}

const MODELS: { key: string; label: string; hint: string }[] = [
  { key: 'opus', label: 'Opus 5.5', hint: 'Most capable, for hard tasks' },
  { key: 'sonnet', label: 'Sonnet 5.5', hint: 'Fast and smart, a great default' },
  { key: 'haiku', label: 'Haiku 4.5', hint: 'Quick and cheap, for small jobs' },
  { key: 'fable', label: 'Fable 5.1', hint: 'Top tier' },
  { key: 'default', label: 'Default', hint: 'Whatever your Claude Code uses' },
];
const LABEL: Record<string, string> = Object.fromEntries(MODELS.map((m) => [m.key, m.label === 'Default' ? '' : m.label]));
const PREF = 'office-dispatch';

export class Dispatch {
  private el = document.getElementById('dispatch')!;
  private entries: Entry[] = [];
  private model = 'sonnet';
  private permission: 'edit' | 'auto' = 'edit';
  private project = '';
  private projects: string[] = [];
  private pollTimer = 0;
  private unavailable = new Set<string>();
  onOpenChange?: (open: boolean) => void;

  constructor(
    private office: Office,
    private director: Director,
    private world: World,
    private sound: Sound,
  ) {
    try {
      const p = JSON.parse(localStorage.getItem(PREF) ?? '{}');
      if (p.model) this.model = p.model;
      if (p.permission) this.permission = p.permission;
      if (p.project) this.project = p.project;
      for (const m of p.unavailable ?? []) this.unavailable.add(m);
    } catch {
      /* ignore */
    }
    this.el.innerHTML = `
      <header><b>🗂️ Dispatch</b><small>Give an agent a real task</small><button class="x" title="Close (Esc)">✕</button></header>
      <div class="body">
        <label>Model</label>
        <div class="models">${MODELS.map((m) => `<button data-m="${m.key}" title="${m.hint}">${m.label}</button>`).join('')}</div>
        <label>Project folder</label>
        <select class="proj"></select>
        <input class="path" placeholder="…or paste a folder path, e.g. C:\\Projects\\my-app" spellcheck="false" />
        <label>Allowed to</label>
        <div class="perm">
          <button data-p="edit" title="Reads and edits files; shell commands are refused">Edit files</button>
          <button data-p="auto" title="Edits files and runs commands; Claude's auto mode blocks risky actions">Edit + run commands</button>
        </div>
        <label>Task</label>
        <textarea class="task" rows="4" placeholder="e.g. Add a dark mode toggle to the settings page and update the README"></textarea>
        <button class="go">🔔 Call an agent</button>
        <div class="err"></div>
        <label class="tl">Tasks</label>
        <div class="list"></div>
      </div>`;
    this.el.querySelector('.x')!.addEventListener('click', () => this.close());
    this.el.querySelectorAll<HTMLButtonElement>('[data-m]').forEach((b) => (b.onclick = () => this.setModel(b.dataset.m!)));
    this.el.querySelectorAll<HTMLButtonElement>('[data-p]').forEach((b) => (b.onclick = () => this.setPerm(b.dataset.p as 'edit' | 'auto')));
    const sel = this.el.querySelector<HTMLSelectElement>('.proj')!;
    sel.onchange = () => {
      this.project = sel.value;
      (this.el.querySelector('.path') as HTMLInputElement).value = '';
      this.save();
    };
    this.el.querySelector<HTMLButtonElement>('.go')!.onclick = () => this.call();
    // typing here must never move the player or fire hotkeys
    for (const f of this.el.querySelectorAll<HTMLElement>('input, textarea, select')) {
      f.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') this.close();
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) this.call();
      });
      f.addEventListener('keyup', (e) => e.stopPropagation());
    }
    this.setModel(this.model);
    this.setPerm(this.permission);
  }

  get isOpen() {
    return this.el.classList.contains('open');
  }

  open() {
    this.el.classList.add('open');
    document.body.classList.add('dispatching');
    this.loadProjects();
    this.loadDefaultModel();
    this.render();
    setTimeout(() => this.el.querySelector<HTMLTextAreaElement>('.task')!.focus(), 30);
    clearInterval(this.pollTimer);
    this.pollTimer = window.setInterval(() => this.poll(), 3000);
    this.onOpenChange?.(true);
  }

  close() {
    if (!this.isOpen) return;
    this.el.classList.remove('open');
    document.body.classList.remove('dispatching');
    clearInterval(this.pollTimer);
    (document.activeElement as HTMLElement)?.blur?.();
    this.onOpenChange?.(false);
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  private save() {
    try {
      localStorage.setItem(PREF, JSON.stringify({ model: this.model, permission: this.permission, project: this.project, unavailable: [...this.unavailable] }));
    } catch {
      /* ignore */
    }
  }

  private setModel(m: string) {
    this.model = MODELS.some((x) => x.key === m) ? m : 'sonnet';
    this.el.querySelectorAll<HTMLButtonElement>('[data-m]').forEach((b) => b.classList.toggle('on', b.dataset.m === this.model));
    this.save();
  }

  private setPerm(p: 'edit' | 'auto') {
    this.permission = p;
    this.el.querySelectorAll<HTMLButtonElement>('[data-p]').forEach((b) => b.classList.toggle('on', b.dataset.p === p));
    this.save();
  }

  private async api(path: string, body?: unknown) {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', 'x-agent-office': '1' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  }

  private async loadDefaultModel() {
    const j = await this.api('/api/models');
    const b = this.el.querySelector<HTMLButtonElement>('[data-m="default"]');
    if (j.ok && j.default && b) {
      b.textContent = `Default · ${modelLabel(j.default)}`;
      LABEL.default = modelLabel(j.default);
    }
    this.markUnavailable();
  }

  private markUnavailable() {
    this.el.querySelectorAll<HTMLButtonElement>('[data-m]').forEach((b) => {
      const na = this.unavailable.has(b.dataset.m!);
      b.classList.toggle('na', na);
      b.title = na ? 'Your API key cannot use this model' : (MODELS.find((m) => m.key === b.dataset.m)?.hint ?? '');
    });
  }

  private async loadProjects() {
    const j = await this.api('/api/projects');
    if (!j.ok) return;
    this.projects = j.projects;
    if (!this.project || !this.projects.includes(this.project)) this.project = this.project || this.projects[0] || '';
    const sel = this.el.querySelector<HTMLSelectElement>('.proj')!;
    const list = this.projects.includes(this.project) || !this.project ? this.projects : [this.project, ...this.projects];
    sel.innerHTML = list.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
    sel.value = this.project;
  }

  private setError(msg: string) {
    this.el.querySelector('.err')!.textContent = msg;
  }

  /** Ring the bell: a new agent walks in, then gets the task. */
  private async call() {
    const taskEl = this.el.querySelector<HTMLTextAreaElement>('.task')!;
    const pathEl = this.el.querySelector<HTMLInputElement>('.path')!;
    const task = taskEl.value.trim();
    const project = pathEl.value.trim() || this.project;
    if (!task) return this.setError('Write a task first.');
    if (!project) return this.setError('Pick a project folder.');
    this.setError('');
    if (pathEl.value.trim()) {
      this.project = pathEl.value.trim();
      this.save();
    }
    taskEl.value = '';
    const runId = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    this.world.ringBell();
    this.sound.bell(this.world.manager.center.clone().setY(0.9));

    const entry: Entry = {
      runId,
      charId: 'run:' + runId,
      name: '…',
      color: '#D97757',
      model: LABEL[this.model] || 'Default',
      project,
      task,
      status: 'coming',
      startedAt: Date.now(),
    };
    this.entries.unshift(entry);
    this.director.expectRun(runId, entry.charId);
    const arrived = this.office.summon(runId, project, LABEL[this.model]);
    const a = this.office.agents.get(entry.charId);
    if (a) {
      entry.name = a.name;
      entry.color = hex(a.rig.accent);
    }
    this.render();
    await arrived;
    const agent = this.office.agents.get(entry.charId);
    agent?.say('Yes, boss? 🙂', 'say', 1.6);
    await new Promise((r) => setTimeout(r, 900));
    const j = await this.api('/api/run', { runId, project, model: this.model, permission: this.permission, task });
    if (!j.ok) {
      entry.status = 'failed';
      entry.result = j.error || 'Could not start the task.';
      entry.endedAt = Date.now();
      agent?.say('I can’t do that: ' + entry.result, 'say', 4);
      if (agent) setTimeout(() => this.office.leave(agent.id, false, false), 3500);
    } else {
      entry.status = 'running';
      agent?.say(pickLine(), 'say', 2);
    }
    this.render();
  }

  /** Live events (RunDone) update the task list immediately. */
  onEvent(e: OfficeEvent) {
    if (e.kind !== 'RunDone' || !e.runId) return;
    const entry = this.entries.find((x) => x.runId === e.runId);
    if (!entry) return;
    if (entry.status !== 'stopped') entry.status = e.ok ? 'done' : 'failed';
    entry.result = e.detail;
    this.noteModelError(entry);
    entry.endedAt = Date.now();
    this.sound.ding(this.world.manager.center.clone().setY(1));
    this.render();
  }

  /** "key not allowed to access model": remember it and say so in plain words. */
  private noteModelError(entry: Entry) {
    const r = entry.result ?? '';
    if (!/not allowed to access model|model.*not (available|found)|unrecognized_model/i.test(r)) return;
    const key = MODELS.find((m) => m.label === entry.model)?.key;
    if (key && key !== 'default') {
      this.unavailable.add(key);
      this.save();
      this.markUnavailable();
      if (this.model === key) this.setModel('default');
    }
    const allowed = /models=\[([^\]]*)\]/.exec(r)?.[1]?.replace(/'/g, '');
    entry.result = `Your API key can’t use ${entry.model}${allowed ? ` (it allows: ${allowed})` : ''}. Pick another model, such as Default.`;
  }

  private async poll() {
    if (!this.entries.some((x) => x.status === 'running')) return this.render();
    const j = await this.api('/api/runs');
    if (!j.ok) return;
    for (const r of j.runs as { runId: string; status: string; result?: string; cost?: number; endedAt?: number }[]) {
      const e = this.entries.find((x) => x.runId === r.runId);
      if (!e) continue;
      if (r.status !== 'running' && e.status === 'running') {
        e.status = r.status as Entry['status'];
        e.result = r.result;
        e.endedAt = r.endedAt;
      }
      e.cost = r.cost;
    }
    this.render();
  }

  private async stop(runId: string) {
    const e = this.entries.find((x) => x.runId === runId);
    if (!e) return;
    e.status = 'stopped';
    this.render();
    await this.api('/api/run/stop', { runId });
  }

  private render() {
    const list = this.el.querySelector('.list')!;
    const now = Date.now();
    list.innerHTML = this.entries.length
      ? ''
      : '<div class="empty">No tasks yet. Write one above and ring the bell.</div>';
    for (const e of this.entries.slice(0, 20)) {
      const div = document.createElement('div');
      div.className = `task ${e.status}`;
      const secs = Math.round(((e.endedAt ?? now) - e.startedAt) / 1000);
      const time = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
      div.innerHTML = `
        <div class="top"><i style="background:${e.color}"></i><b>${esc(e.name)}</b><span class="mdl">${esc(e.model)}</span>
          <span class="chip ${e.status}">${e.status}</span><span class="time">${time}</span></div>
        <div class="what" title="${esc(e.task)}">${esc(e.task)}</div>
        <div class="where">📁 ${esc(e.project)}</div>`;
      if (e.status === 'running' || e.status === 'coming') {
        const b = document.createElement('button');
        b.className = 'stop';
        b.textContent = 'Stop';
        b.onclick = () => this.stop(e.runId);
        div.querySelector('.top')!.appendChild(b);
      }
      if (e.result) {
        const r = document.createElement('div');
        r.className = 'result';
        r.dir = 'auto';
        r.textContent = e.result;
        div.appendChild(r);
      }
      list.appendChild(div);
    }
    // the manager's own monitor mirrors the list
    this.world.drawManagerScreen(
      this.entries.map((e) => `${e.status === 'done' ? '✓' : e.status === 'failed' || e.status === 'stopped' ? '✗' : '▶'} ${e.name} · ${e.model} — ${e.task}`),
    );
  }
}

function pickLine() {
  const l = ['On it! 💪', 'Consider it done.', 'Got it, boss!', 'I’ll get right on it.'];
  return l[Math.floor(Math.random() * l.length)];
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
