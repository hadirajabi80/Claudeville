// Team mode: build a team (role, seniority, skills, model per member) and send it a request.
// The Team Lead plans who does what, members do exactly their own job as experts in it
// (real `claude -p` runs in the project folder), then the lead reviews and reports back.
import type { Office } from './office';
import type { Director } from './director';
import type { Sound } from './sound';
import type { World } from './world';
import type { OfficeEvent } from './types';
import type { Gender } from './character';
import { randomName } from './names';
import { hex } from './palette';

type Perm = 'readonly' | 'edit' | 'auto';

interface RoleDef {
  title: string;
  icon: string;
  skills: string[];
  perm: Perm;
  duty: string;
}

export const ROLES: Record<string, RoleDef> = {
  lead: { title: 'Team Lead', icon: '🧭', skills: ['architecture', 'planning', 'code review', 'mentoring'], perm: 'readonly', duty: 'Plans the work, splits it between the team, reviews the result and writes the final summary. Does not write feature code.' },
  po: { title: 'Product Owner', icon: '📋', skills: ['user stories', 'acceptance criteria', 'prioritization', 'scope'], perm: 'edit', duty: 'Turns the request into clear user stories and acceptance criteria in docs/requirements.md. Does not write code.' },
  designer: { title: 'UI/UX Designer', icon: '🎨', skills: ['UX flows', 'visual design', 'accessibility', 'design tokens'], perm: 'edit', duty: 'Defines screens, layout and visual style in docs/design.md and in design tokens / CSS variables. Does not write business logic.' },
  frontend: { title: 'Frontend Engineer', icon: '🖥️', skills: ['React', 'TypeScript', 'CSS', 'accessibility', 'state management'], perm: 'edit', duty: 'Builds the user interface: components, pages, styles and client-side logic. Does not change server code or infrastructure.' },
  backend: { title: 'Backend Engineer', icon: '🗄️', skills: ['Node.js', 'REST APIs', 'databases', 'auth', 'testing'], perm: 'edit', duty: 'Builds server-side code: APIs, data models, business logic and their tests. Does not change UI code or infrastructure.' },
  devops: { title: 'DevOps Engineer', icon: '🚀', skills: ['CI/CD', 'Docker', 'GitHub Actions', 'scripts', 'monitoring'], perm: 'auto', duty: 'Owns build, CI/CD, containers, deployment and developer scripts. Does not change application features.' },
  qa: { title: 'QA Engineer', icon: '🧪', skills: ['test plans', 'automated tests', 'edge cases', 'regression'], perm: 'auto', duty: 'Writes and runs tests, checks the acceptance criteria and reports bugs in docs/qa-report.md. Only fixes tests, not features.' },
  security: { title: 'Security Engineer', icon: '🛡️', skills: ['threat modeling', 'OWASP', 'secrets', 'dependency audit'], perm: 'edit', duty: 'Reviews the change for security issues, fixes clear vulnerabilities and reports findings in docs/security.md.' },
  data: { title: 'Data Engineer', icon: '📊', skills: ['SQL', 'data modeling', 'migrations', 'ETL'], perm: 'edit', duty: 'Owns schemas, migrations, data pipelines and queries.' },
  writer: { title: 'Technical Writer', icon: '✍️', skills: ['documentation', 'README', 'API docs', 'changelogs'], perm: 'edit', duty: 'Writes and updates documentation (README, docs/, changelog). Does not change code.' },
};

const LEVELS: Record<string, string> = {
  Junior: 'Keep changes small and conventional, and follow the existing patterns closely.',
  'Mid-level': 'Deliver solid, well-structured work that follows the project’s conventions.',
  Senior: 'Make sound design decisions, handle edge cases and add tests where they matter.',
  Staff: 'Think about the whole system: architecture, maintainability and performance.',
  Principal: 'Set the technical direction: be pragmatic, rigorous and concise.',
};

const MODELS: [string, string][] = [
  ['default', 'Default'],
  ['opus', 'Opus 5.5'],
  ['sonnet', 'Sonnet 5.5'],
  ['haiku', 'Haiku 4.5'],
  ['fable', 'Fable 5.1'],
];
const modelName = (k: string) => MODELS.find((m) => m[0] === k)?.[1] ?? (k && k !== 'default' ? k : 'Default');

export type AgentKind = 'claude' | 'codex' | 'cursor' | 'zcode';
export const AGENTS: Record<AgentKind, { label: string; icon: string }> = {
  claude: { label: 'Claude', icon: '✳️' },
  codex: { label: 'ChatGPT · Codex', icon: '🟢' },
  cursor: { label: 'Cursor', icon: '⬛' },
  zcode: { label: 'Z Code', icon: '🔷' },
};
interface AgentStatus {
  available: boolean;
  hint: string;
  models: string[];
}
const PERMS: [Perm, string][] = [
  ['readonly', 'Read only'],
  ['edit', 'Edit files'],
  ['auto', 'Edit + run commands'],
];

export interface Member {
  id: string;
  role: string;
  level: string;
  name: string;
  gender: Gender;
  model: string;
  /** which coding agent this member is */
  agent: AgentKind;
  skills: string[];
  perm: Perm;
}

interface Task {
  memberId: string;
  task: string;
  phase: number;
  runId?: string;
  status: 'waiting' | 'running' | 'done' | 'failed' | 'stopped';
  result?: string;
  startedAt?: number;
  endedAt?: number;
}

type Stage = 'idle' | 'planning' | 'working' | 'reviewing' | 'done' | 'failed' | 'stopped';

/** The team job as the server sees it (the server coordinates, so it survives page reloads). */
interface TeamState {
  stage: Stage;
  project: string;
  request: string;
  members: Member[];
  plan: string;
  summary: string;
  tasks: Task[];
}

const KEY = 'office-team';

export class Team {
  private el = document.getElementById('team')!;
  members: Member[] = [];
  private project = '';
  private editing: string | null = null;
  private state: TeamState | null = null;
  private agentStatus: Partial<Record<AgentKind, AgentStatus>> = {};
  private tick = 0;
  onOpenChange?: (open: boolean) => void;

  constructor(
    private office: Office,
    private director: Director,
    private world: World,
    private sound: Sound,
  ) {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) ?? '{}');
      if (Array.isArray(s.members)) this.members = s.members.map((m: Member) => ({ ...m, agent: m.agent ?? 'claude' }));
      if (s.project) this.project = s.project;
    } catch {
      /* ignore */
    }
    this.el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.close();
    });
    this.el.addEventListener('keyup', (e) => e.stopPropagation());
    this.renderAll();
  }

  get isOpen() {
    return this.el.classList.contains('open');
  }
  get busy() {
    const st = this.state?.stage;
    return st === 'planning' || st === 'working' || st === 'reviewing';
  }

  open() {
    this.el.classList.add('open');
    this.loadProjects();
    this.fetchState();
    this.loadAgents();
    this.renderAll();
    clearInterval(this.tick);
    this.tick = window.setInterval(() => this.busy && this.renderProgress(), 1000);
    this.onOpenChange?.(true);
  }

  close() {
    if (!this.isOpen) return;
    this.el.classList.remove('open');
    clearInterval(this.tick);
    (document.activeElement as HTMLElement)?.blur?.();
    this.onOpenChange?.(false);
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  private save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ members: this.members, project: this.project }));
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------------------------------ building the team

  private starterTeam() {
    const mk = (role: string, level: string, gender: Gender): Member => ({
      id: Math.random().toString(36).slice(2, 9),
      role,
      level,
      name: this.uniqueName(gender),
      gender,
      model: 'default',
      agent: 'claude',
      skills: [...ROLES[role].skills],
      perm: ROLES[role].perm,
    });
    this.members = [mk('lead', 'Staff', 'm'), mk('po', 'Senior', 'f'), mk('frontend', 'Senior', 'f'), mk('backend', 'Senior', 'm'), mk('devops', 'Mid-level', 'm'), mk('qa', 'Mid-level', 'f')];
    this.save();
    this.renderAll();
  }

  private uniqueName(g: Gender) {
    for (let i = 0; i < 40; i++) {
      const n = randomName(g);
      if (!this.members.some((m) => m.name === n)) return n;
    }
    return randomName(g);
  }

  private formValues(): Member | null {
    const f = this.el.querySelector<HTMLFormElement>('form.add')!;
    const v = (n: string) => (f.elements.namedItem(n) as HTMLInputElement | HTMLSelectElement).value;
    const role = v('role');
    const name = v('name').trim() || this.uniqueName(v('gender') as Gender);
    return {
      id: this.editing ?? Math.random().toString(36).slice(2, 9),
      role,
      level: v('level'),
      name: name.slice(0, 16),
      gender: v('gender') as Gender,
      model: v('model').trim() || 'default',
      agent: v('agent') as AgentKind,
      skills: v('skills')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 12),
      perm: v('perm') as Perm,
    };
  }

  private fillForm(m: Member | null) {
    const f = this.el.querySelector<HTMLFormElement>('form.add')!;
    const set = (n: string, val: string) => ((f.elements.namedItem(n) as HTMLInputElement).value = val);
    const role = m?.role ?? 'frontend';
    set('role', role);
    set('level', m?.level ?? 'Senior');
    set('gender', m?.gender ?? 'm');
    set('name', m?.name ?? '');
    set('agent', m?.agent ?? 'claude');
    this.syncModels(m?.agent ?? 'claude');
    set('model', m?.model ?? 'default');
    set('skills', (m?.skills ?? ROLES[role].skills).join(', '));
    set('perm', m?.perm ?? ROLES[role].perm);
    (f.querySelector('.addbtn') as HTMLButtonElement).textContent = m ? 'Save changes' : '+ Add to team';
    (f.querySelector('.cancel') as HTMLButtonElement).style.display = m ? '' : 'none';
  }

  // ------------------------------------------------------------------ running a request (on the server)

  private memberOf(id: string): Member | undefined {
    return this.state?.members.find((m) => m.id === id) ?? this.members.find((m) => m.id === id);
  }

  private bring(m: Member) {
    return this.office.callMember(m.id, { name: m.name, gender: m.gender, subtitle: `${ROLES[m.role]?.title ?? m.role} · ${m.level}`, model: m.model === 'default' ? (m.agent && m.agent !== 'claude' ? AGENTS[m.agent].label : '') : modelName(m.model) });
  }

  /** Live events from the server: who does which run, and the team's progress. */
  onEvent(e: OfficeEvent & { team?: TeamState; member?: Member }) {
    if (e.kind === 'TeamTask' && e.member && e.runId) {
      this.director.expectRun(e.runId, this.bring(e.member));
    } else if (e.kind === 'TeamUpdate' && e.team) {
      const before = this.state?.stage;
      this.state = e.team;
      if (before !== this.state.stage && ['done', 'failed', 'stopped'].includes(this.state.stage)) this.sound.chime(this.world.manager.center.clone().setY(1));
      this.renderProgress();
    }
  }

  /** After a page reload: put the members who are still working back on their runs. */
  restore(events: (OfficeEvent & { member?: Member })[]) {
    const finished = new Set(events.filter((e) => e.kind === 'RunDone' && e.runId).map((e) => e.runId));
    for (const e of events) if (e.kind === 'TeamTask' && e.member && e.runId && !finished.has(e.runId)) this.director.expectRun(e.runId, this.bring(e.member));
    this.fetchState();
  }

  private async fetchState() {
    const j = await this.api('/api/team');
    if (j.ok && j.team) {
      this.state = j.team;
      this.renderProgress();
    }
  }

  private async api(path: string, body?: unknown) {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', 'x-agent-office': '1' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  }

  private async send() {
    const ta = this.el.querySelector<HTMLTextAreaElement>('.req')!;
    const pathEl = this.el.querySelector<HTMLInputElement>('.path')!;
    const request = ta.value.trim();
    if (pathEl.value.trim()) {
      this.project = pathEl.value.trim();
      this.save();
    }
    const err = this.el.querySelector('.err')!;
    if (!this.members.length) return void (err.textContent = 'Add some team members first (or use the starter team).');
    if (!request) return void (err.textContent = 'Write what the team should do.');
    if (!this.project) return void (err.textContent = 'Pick a project folder.');
    err.textContent = '';
    this.world.ringBell();
    this.sound.bell(this.world.manager.center.clone().setY(0.9));
    // everyone shows up for the kickoff
    for (const m of this.members) this.bring(m);
    const j = await this.api('/api/team/run', { project: this.project, request, members: this.members });
    if (!j.ok) return void (err.textContent = j.error || 'Could not start the team.');
    this.state = j.team;
    this.renderProgress();
  }

  private async stop() {
    await this.api('/api/team/stop', {});
  }

  // ------------------------------------------------------------------ rendering

  private async loadAgents() {
    const j = await this.api('/api/agents');
    if (!j.ok) return;
    this.agentStatus = j.agents;
    const form = this.el.querySelector<HTMLFormElement>('form.add');
    if (form) this.syncModels((form.elements.namedItem('agent') as HTMLSelectElement).value as AgentKind);
    this.renderMembers();
  }

  /** Model suggestions and a status note for the chosen agent. */
  private syncModels(agent: AgentKind) {
    const dl = this.el.querySelector('#team-models');
    const note = this.el.querySelector('.agentnote');
    const st = this.agentStatus[agent];
    const models = st?.models ?? (agent === 'claude' ? MODELS.map((m) => m[0]) : ['default']);
    if (dl) dl.innerHTML = models.map((m) => `<option value="${esc(m)}">${esc(agent === 'claude' ? modelName(m) : m)}</option>`).join('');
    if (note) note.textContent = st ? (st.available ? `${AGENTS[agent].label} is ready on this PC.` : `⚠ ${st.hint}`) : '';
    note?.classList.toggle('bad', !!st && !st.available);
  }

  private async loadProjects() {
    const j = await this.api('/api/projects');
    if (!j.ok) return;
    const sel = this.el.querySelector<HTMLSelectElement>('.proj');
    if (!sel) return;
    const list: string[] = j.projects;
    if (this.project && !list.includes(this.project)) list.unshift(this.project);
    if (!this.project) this.project = list[0] ?? '';
    sel.innerHTML = list.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
    sel.value = this.project;
  }

  private renderAll() {
    this.el.innerHTML = `
      <header><b>👥 Work Room team</b><small>Mix Claude, Codex, Cursor and Z Code</small><button class="x" title="Close (Esc)">✕</button></header>
      <div class="body">
        <label>Project folder</label>
        <select class="proj"></select>
        <input class="path" placeholder="…or paste a folder path" spellcheck="false" />
        <label>Team <button class="starter" type="button">Use starter team</button></label>
        <div class="members"></div>
        <form class="add">
          <div class="row"><select name="role">${Object.entries(ROLES)
            .map(([k, r]) => `<option value="${k}">${r.icon} ${r.title}</option>`)
            .join('')}</select><select name="level">${Object.keys(LEVELS)
            .map((l) => `<option>${l}</option>`)
            .join('')}</select></div>
          <div class="row"><select name="gender"><option value="m">Male</option><option value="f">Female</option></select><input name="name" placeholder="Name (random if empty)" maxlength="16" /><button type="button" class="dice" title="Random name">🎲</button></div>
          <div class="row"><select name="agent">${(Object.keys(AGENTS) as AgentKind[]).map((k) => `<option value="${k}">${AGENTS[k].icon} ${AGENTS[k].label}</option>`).join('')}</select><input name="model" list="team-models" placeholder="Model (default)" /></div>
          <datalist id="team-models"></datalist>
          <div class="agentnote"></div>
          <div class="row"><select name="perm">${PERMS.map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select></div>
          <input name="skills" placeholder="Skills, comma separated" />
          <div class="row"><button type="submit" class="addbtn">+ Add to team</button><button type="button" class="cancel" style="display:none">Cancel</button></div>
        </form>
        <label>Request for the team</label>
        <textarea class="req" rows="4" placeholder="e.g. Add user sign-up with email verification, with tests and a CI job"></textarea>
        <div class="row"><button class="go">🚀 Send to team</button><button class="stop" style="display:none">■ Stop</button></div>
        <div class="err"></div>
        <div class="progress"></div>
      </div>`;
    this.el.querySelector('.x')!.addEventListener('click', () => this.close());
    this.el.querySelector('.starter')!.addEventListener('click', () => this.starterTeam());
    this.el.querySelector('.go')!.addEventListener('click', () => !this.busy && this.send());
    this.el.querySelector('.stop')!.addEventListener('click', () => this.stop());
    const sel = this.el.querySelector<HTMLSelectElement>('.proj')!;
    sel.onchange = () => {
      this.project = sel.value;
      this.save();
    };
    const form = this.el.querySelector<HTMLFormElement>('form.add')!;
    const agentSel = form.elements.namedItem('agent') as HTMLSelectElement;
    agentSel.onchange = () => {
      this.syncModels(agentSel.value as AgentKind);
      (form.elements.namedItem('model') as HTMLInputElement).value = 'default';
    };
    const roleSel = form.elements.namedItem('role') as HTMLSelectElement;
    roleSel.onchange = () => {
      const r = ROLES[roleSel.value];
      (form.elements.namedItem('skills') as HTMLInputElement).value = r.skills.join(', ');
      (form.elements.namedItem('perm') as HTMLSelectElement).value = r.perm;
    };
    form.querySelector('.dice')!.addEventListener('click', () => {
      (form.elements.namedItem('name') as HTMLInputElement).value = this.uniqueName((form.elements.namedItem('gender') as HTMLSelectElement).value as Gender);
    });
    form.querySelector('.cancel')!.addEventListener('click', () => {
      this.editing = null;
      this.fillForm(null);
    });
    form.onsubmit = (e) => {
      e.preventDefault();
      const m = this.formValues();
      if (!m) return;
      const i = this.members.findIndex((x) => x.id === m.id);
      if (i >= 0) this.members[i] = m;
      else this.members.push(m);
      this.editing = null;
      this.save();
      this.fillForm(null);
      this.renderMembers();
    };
    this.fillForm(null);
    this.renderMembers();
    this.renderProgress();
    this.loadProjects();
  }

  private renderMembers() {
    const box = this.el.querySelector('.members')!;
    if (!this.members.length) {
      box.innerHTML = '<div class="empty">No one yet. Add members below or use the starter team.</div>';
      return;
    }
    box.innerHTML = '';
    for (const m of this.members) {
      const r = ROLES[m.role];
      const a = this.office.agents.get('team:' + m.id);
      const div = document.createElement('div');
      div.className = 'member';
      div.innerHTML = `<span class="ic">${r.icon}</span><div class="who"><b>${esc(m.name)}</b> <span class="agent">${AGENTS[m.agent ?? 'claude'].icon} ${AGENTS[m.agent ?? 'claude'].label}</span> <span class="mdl">${esc(modelName(m.model))}</span>${this.agentStatus[m.agent ?? 'claude'] && !this.agentStatus[m.agent ?? 'claude']!.available ? '<div class="warn">Can’t run on this PC yet</div>' : ''}<div class="role">${m.level} ${r.title}</div><div class="skills">${m.skills
        .map((s) => `<i>${esc(s)}</i>`)
        .join('')}</div></div><button class="ed" title="Edit">✎</button><button class="rm" title="Remove">✕</button>`;
      if (a) (div.querySelector('.ic') as HTMLElement).style.boxShadow = `inset 0 0 0 2px ${hex(a.rig.accent)}`;
      div.querySelector('.ed')!.addEventListener('click', () => {
        this.editing = m.id;
        this.fillForm(m);
      });
      div.querySelector('.rm')!.addEventListener('click', () => {
        this.members = this.members.filter((x) => x.id !== m.id);
        this.office.dismissMember(m.id);
        this.save();
        this.renderMembers();
      });
      box.appendChild(div);
    }
  }

  private renderProgress() {
    const box = this.el.querySelector('.progress');
    if (!box) return;
    (this.el.querySelector('.go') as HTMLButtonElement).disabled = this.busy;
    (this.el.querySelector('.stop') as HTMLElement).style.display = this.busy ? '' : 'none';
    const st = this.state;
    if (!st || st.stage === 'idle') {
      box.innerHTML = '';
      return;
    }
    const stageText: Record<Stage, string> = {
      idle: '',
      planning: '🧭 The team lead is planning…',
      working: '🛠️ The team is working',
      reviewing: '🔍 The team lead is reviewing…',
      done: '✅ Done',
      failed: '⚠️ Finished with problems',
      stopped: '■ Stopped',
    };
    const now = Date.now();
    let html = `<div class="stage">${stageText[st.stage]}</div><div class="plan">“${esc(st.request)}”</div>`;
    if (st.plan) html += `<div class="plan">Plan: ${esc(st.plan)}</div>`;
    const phases = [...new Set(st.tasks.map((t) => t.phase))];
    for (const p of phases) {
      html += `<div class="phase">Phase ${p + 1}</div>`;
      for (const t of st.tasks.filter((x) => x.phase === p)) {
        const m = this.memberOf(t.memberId);
        const r = m ? ROLES[m.role] : undefined;
        const secs = t.startedAt ? Math.round(((t.endedAt ?? now) - t.startedAt) / 1000) : 0;
        html += `<div class="task ${t.status}"><div class="top">${r?.icon ?? '👤'} <b>${esc(m?.name ?? '?')}</b> <small>${r?.title ?? ''}</small><span class="chip ${t.status}">${t.status}</span>${secs ? `<span class="time">${secs}s</span>` : ''}</div><div class="what">${esc(t.task)}</div>${t.result ? `<details><summary>Report</summary><div class="result" dir="auto">${esc(t.result)}</div></details>` : ''}</div>`;
      }
    }
    if (st.summary) html += `<div class="summary"><b>Team lead’s summary</b><div dir="auto">${esc(st.summary)}</div></div>`;
    box.innerHTML = html;
    // mirror on the manager's monitor
    this.world.drawManagerScreen([
      `TEAM: ${stageText[st.stage]}`,
      ...st.tasks.map((t) => {
        const m = this.memberOf(t.memberId);
        return `${t.status === 'done' ? '✓' : t.status === 'failed' ? '✗' : '▶'} ${m?.name ?? '?'} · ${m ? ROLES[m.role]?.title : ''}`;
      }),
    ]);
  }
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
