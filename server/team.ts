// Team mode, coordinated on the server so a job keeps going even if the page reloads or closes.
// The lead plans who does what, members do exactly their own job (real `claude -p` runs),
// tasks in the same phase run side by side, then the lead reviews and writes the summary.
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { launchRun, stopRun } from './runs';

type Perm = 'readonly' | 'edit' | 'auto';

export interface Member {
  id: string;
  role: string;
  level: string;
  name: string;
  gender: 'm' | 'f';
  model: string;
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

export interface TeamState {
  id: string;
  stage: 'idle' | 'planning' | 'working' | 'reviewing' | 'done' | 'failed' | 'stopped';
  project: string;
  request: string;
  members: Member[];
  plan: string;
  summary: string;
  tasks: Task[];
  startedAt: number;
  endedAt?: number;
  /** run id of the lead's current planning / review run (so it can be stopped) */
  leadRun?: string;
}

const ROLE_TITLE: Record<string, string> = {
  lead: 'Team Lead',
  po: 'Product Owner',
  designer: 'UI/UX Designer',
  frontend: 'Frontend Engineer',
  backend: 'Backend Engineer',
  devops: 'DevOps Engineer',
  qa: 'QA Engineer',
  security: 'Security Engineer',
  data: 'Data Engineer',
  writer: 'Technical Writer',
};
const ROLE_DUTY: Record<string, string> = {
  lead: 'Plans the work, splits it between the team, reviews the result and writes the final summary. Does not write feature code.',
  po: 'Turns the request into clear user stories and acceptance criteria in docs/requirements.md. Does not write code.',
  designer: 'Defines screens, layout and visual style in docs/design.md and in design tokens / CSS variables. Does not write business logic.',
  frontend: 'Builds the user interface: components, pages, styles and client-side logic. Does not change server code or infrastructure.',
  backend: 'Builds server-side code: APIs, data models, business logic and their tests. Does not change UI code or infrastructure.',
  devops: 'Owns build, CI/CD, containers, deployment and developer scripts. Does not change application features.',
  qa: 'Writes and runs tests, checks the acceptance criteria and reports bugs in docs/qa-report.md. Only fixes tests, not features.',
  security: 'Reviews the change for security issues, fixes clear vulnerabilities and reports findings in docs/security.md.',
  data: 'Owns schemas, migrations, data pipelines and queries.',
  writer: 'Writes and updates documentation (README, docs/, changelog). Does not change code.',
};
const LEVEL_NOTE: Record<string, string> = {
  Junior: 'Keep changes small and conventional, and follow the existing patterns closely.',
  'Mid-level': 'Deliver solid, well-structured work that follows the project’s conventions.',
  Senior: 'Make sound design decisions, handle edge cases and add tests where they matter.',
  Staff: 'Think about the whole system: architecture, maintainability and performance.',
  Principal: 'Set the technical direction: be pragmatic, rigorous and concise.',
};

let state: TeamState | null = null;
let stopRequested = false;

const title = (m: Member) => ROLE_TITLE[m.role] ?? m.role;

function roster(members: Member[]) {
  return members.map((m) => `- ${m.id}: ${m.name}, ${m.level} ${title(m)} (skills: ${m.skills.join(', ')}). Duty: ${ROLE_DUTY[m.role] ?? ''}`).join('\n');
}

function persona(m: Member, members: Member[]) {
  return [
    `You are ${m.name}, a ${m.level} ${title(m)} on a software team.`,
    `Your expertise: ${m.skills.join(', ')}. You are an expert in exactly this work and you do it the way a ${m.level} ${title(m)} would.`,
    `Your responsibility: ${ROLE_DUTY[m.role] ?? ''}`,
    LEVEL_NOTE[m.level] ?? '',
    '',
    'The team:',
    roster(members),
  ].join('\n');
}

function parsePlan(text: string, members: Member[]): { plan: string; phases: { memberId: string; task: string }[][] } {
  try {
    const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    const phases: { memberId: string; task: string }[][] = [];
    for (const ph of json.phases ?? []) {
      const list = (Array.isArray(ph) ? ph : [ph])
        .map((x: any) => {
          const m = members.find((mm) => mm.id === x.member || mm.name === x.member);
          return m && x.task ? { memberId: m.id, task: String(x.task) } : null;
        })
        .filter(Boolean) as { memberId: string; task: string }[];
      if (list.length) phases.push(list);
    }
    return { plan: String(json.summary ?? ''), phases };
  } catch {
    return { plan: '', phases: [] };
  }
}

function fallbackPlan(request: string, members: Member[]) {
  const order = [['po', 'designer'], ['frontend', 'backend', 'data'], ['qa', 'devops', 'security', 'writer']];
  return order
    .map((roles) => members.filter((m) => roles.includes(m.role)).map((m) => ({ memberId: m.id, task: `Do your part (as ${title(m)}) of this request: ${request}` })))
    .filter((p) => p.length);
}

async function runTeam(s: TeamState, broadcast: (raw: Record<string, unknown>) => void) {
  const push = () => broadcast({ hook_event_name: 'TeamUpdate', session_id: 'team', team: s });
  const newRun = () => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  /** Tell the page which character does this run, then start it. */
  const run = (m: Member, prompt: string, perm: Perm, runId = newRun()) => {
    broadcast({ hook_event_name: 'TeamTask', session_id: 'team', office_run: runId, member: m });
    return launchRun({ runId, project: s.project, model: m.model, permission: perm, task: prompt, raw: true }, broadcast);
  };

  const members = s.members;
  const lead = members.find((m) => m.role === 'lead') ?? members.find((m) => m.role === 'po');
  let phases: { memberId: string; task: string }[][];
  if (members.length === 1) phases = [[{ memberId: members[0].id, task: s.request }]];
  else if (lead) {
    s.stage = 'planning';
    push();
    const prompt = [
      persona(lead, members),
      '',
      'Your manager sent the team this request:',
      `"""${s.request}"""`,
      '',
      'Plan the work. Look at the project files if that helps (you can read but not change them).',
      'Split the request into tasks so that each task matches exactly one member’s role and duty. Do not give coding tasks to the Team Lead or the Product Owner. Skip members who have nothing to do for this request.',
      'Order the work in phases: tasks in the same phase run at the same time; phases run one after another (for example: requirements and design first, then frontend and backend, then tests, DevOps and docs). Do not include a final review: that happens automatically.',
      `Use only these member ids: ${members.map((m) => m.id).join(', ')}.`,
      'Answer with ONLY a JSON object, no other text, in this shape:',
      '{"summary":"one sentence describing the plan","phases":[[{"member":"<id>","task":"<clear, specific task>"}]]}',
    ].join('\n');
    s.leadRun = newRun();
    const r = await run(lead, prompt, 'readonly', s.leadRun);
    s.leadRun = undefined;
    if (stopRequested) return finish(s, 'stopped', push);
    const parsed = parsePlan(r.text, members);
    s.plan = parsed.plan;
    phases = parsed.phases.length ? parsed.phases : fallbackPlan(s.request, members);
    if (!parsed.phases.length) s.plan = 'Default plan: requirements and design, then implementation, then tests, DevOps and docs.';
  } else {
    phases = fallbackPlan(s.request, members);
    s.plan = 'Default plan: requirements and design, then implementation, then tests, DevOps and docs.';
  }

  phases.forEach((ph, i) => ph.forEach((p) => s.tasks.push({ memberId: p.memberId, task: p.task, phase: i, status: 'waiting' })));
  s.stage = 'working';
  push();

  for (let i = 0; i < phases.length; i++) {
    await Promise.all(
      s.tasks
        .filter((t) => t.phase === i)
        .map(async (t) => {
          const m = members.find((x) => x.id === t.memberId)!;
          const prompt = [
            persona(m, members),
            '',
            'Your manager’s request to the team:',
            `"""${s.request}"""`,
            s.plan ? `\nThe team lead’s plan: ${s.plan}` : '',
            '',
            `Your task: ${t.task}`,
            '',
            'Rules:',
            '- Do only the work that belongs to your role. If something belongs to another role, leave it to them.',
            '- Shared hand-off notes live in TEAM_NOTES.md at the project root. Read it first if it exists. When you finish, append a short section "## <your name> (<your role>)" saying what you did and what your teammates need to know.',
            '- End your answer with a short report (2-4 sentences) for your manager.',
          ].join('\n');
          t.runId = newRun();
          t.status = 'running';
          t.startedAt = Date.now();
          push();
          const r = await run(m, prompt, m.perm, t.runId);
          t.status = stopRequested ? 'stopped' : r.ok ? 'done' : 'failed';
          t.result = r.text;
          t.endedAt = Date.now();
          push();
        }),
    );
    if (stopRequested) return finish(s, 'stopped', push);
  }

  const reviewer = members.find((m) => m.role === 'lead');
  if (reviewer && s.tasks.length) {
    s.stage = 'reviewing';
    push();
    const prompt = [
      persona(reviewer, members),
      '',
      'Your manager’s request:',
      `"""${s.request}"""`,
      '',
      'What the team reported:',
      ...s.tasks.map((t) => {
        const m = members.find((x) => x.id === t.memberId)!;
        return `- ${m.name} (${title(m)}), ${t.status}: ${t.result ?? ''}`;
      }),
      '',
      'Review the work against the request: read TEAM_NOTES.md and the files the team changed (you can read but not change files).',
      'Then write the final summary for your manager: what was done and by whom, whether the request is fully met, and any open issues or next steps. Keep it under 150 words.',
    ].join('\n');
    s.leadRun = newRun();
    const r = await run(reviewer, prompt, 'readonly', s.leadRun);
    s.leadRun = undefined;
    s.summary = r.text;
  } else {
    s.summary = s.tasks
      .map((t) => `${members.find((x) => x.id === t.memberId)?.name}: ${t.result ?? t.status}`)
      .join('\n\n');
  }
  finish(s, stopRequested ? 'stopped' : s.tasks.some((t) => t.status === 'failed') ? 'failed' : 'done', push);
}

function finish(s: TeamState, stage: TeamState['stage'], push: () => void) {
  s.stage = stage;
  s.endedAt = Date.now();
  push();
}

const busy = () => !!state && ['planning', 'working', 'reviewing'].includes(state.stage);

export async function handleTeam(req: IncomingMessage, res: ServerResponse, body: string, broadcast: (raw: Record<string, unknown>) => void) {
  const send = (code: number, obj: unknown) => {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(obj));
  };
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (req.headers['x-agent-office'] !== '1' || (origin && host && new URL(origin).host !== host)) return send(403, { ok: false, error: 'forbidden' });
  const url = req.url ?? '';
  if (req.method === 'GET') return send(200, { ok: true, team: state });
  let q: any = {};
  try {
    q = JSON.parse(body || '{}');
  } catch {
    return send(400, { ok: false, error: 'bad json' });
  }
  if (url.startsWith('/api/team/stop')) {
    if (!state || !busy()) return send(200, { ok: true });
    stopRequested = true;
    if (state.leadRun) stopRun(state.leadRun, broadcast);
    for (const t of state.tasks) if (t.status === 'running' && t.runId) stopRun(t.runId, broadcast);
    return send(200, { ok: true });
  }
  if (url.startsWith('/api/team/run')) {
    if (busy()) return send(409, { ok: false, error: 'The team is already working on something.' });
    const project = path.resolve(String(q.project ?? ''));
    const request = String(q.request ?? '').trim().slice(0, 6000);
    const members: Member[] = (Array.isArray(q.members) ? q.members : []).slice(0, 12).map((m: any) => ({
      id: String(m.id).replace(/[^\w-]/g, '').slice(0, 20),
      role: ROLE_TITLE[m.role] ? m.role : 'frontend',
      level: LEVEL_NOTE[m.level] ? m.level : 'Senior',
      name: String(m.name ?? 'Teammate').slice(0, 16),
      gender: m.gender === 'f' ? 'f' : 'm',
      model: String(m.model ?? 'default'),
      skills: (Array.isArray(m.skills) ? m.skills : []).map(String).slice(0, 12),
      perm: m.perm === 'readonly' || m.perm === 'auto' ? m.perm : 'edit',
    }));
    if (!members.length) return send(400, { ok: false, error: 'Add some team members first.' });
    if (!request) return send(400, { ok: false, error: 'Write what the team should do.' });
    if (!fs.existsSync(project) || !fs.statSync(project).isDirectory()) return send(400, { ok: false, error: `Folder not found: ${project}` });
    stopRequested = false;
    state = { id: 'team' + Date.now().toString(36), stage: 'planning', project, request, members, plan: '', summary: '', tasks: [], startedAt: Date.now() };
    const s = state;
    runTeam(s, broadcast).catch((e) => {
      s.summary = `The team stopped because of an error: ${(e as Error).message}`;
      finish(s, 'failed', () => broadcast({ hook_event_name: 'TeamUpdate', session_id: 'team', team: s }));
    });
    return send(200, { ok: true, team: state });
  }
  send(404, { ok: false, error: 'unknown' });
}
