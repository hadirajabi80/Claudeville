// Real task runs dispatched from the manager's desk: `claude -p` in the chosen project folder.
// The run's own hooks report back to the office (tagged with AGENT_OFFICE_RUN), so the summoned
// character works at a desk like any other agent, then reports the result here.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface Run {
  runId: string;
  project: string;
  model: string;
  permission: 'edit' | 'auto';
  task: string;
  status: 'running' | 'done' | 'failed' | 'stopped';
  startedAt: number;
  endedAt?: number;
  session?: string;
  result?: string;
  cost?: number;
  child?: ChildProcess;
}

const runs = new Map<string, Run>();
const MAX_RUNS = 3;

const MODEL_IDS: Record<string, string | undefined> = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-4-5-20251001',
  fable: 'claude-fable-5-1',
  default: undefined,
};

/** The model Claude Code uses when none is given (from env or ~/.claude/settings.json; never reads secrets). */
function defaultModel(): string | null {
  if (process.env.ANTHROPIC_MODEL) return process.env.ANTHROPIC_MODEL;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.claude', 'settings.json'), 'utf8'));
    return s.model ?? s.env?.ANTHROPIC_MODEL ?? null;
  } catch {
    return null;
  }
}

function publicRun(r: Run) {
  const { child: _c, ...rest } = r;
  return rest;
}

/** Folders worth offering in the project picker. */
export function projectCandidates(known: string[]): string[] {
  const out = new Set<string>();
  for (const k of known) if (k && fs.existsSync(k)) out.add(path.resolve(k));
  for (const rootDir of ['C:\\Projects', path.join(process.env.USERPROFILE ?? '', 'Projects'), path.join(process.env.USERPROFILE ?? '', 'source', 'repos')]) {
    try {
      for (const d of fs.readdirSync(rootDir, { withFileTypes: true })) if (d.isDirectory() && !d.name.startsWith('.')) out.add(path.join(rootDir, d.name));
    } catch {
      /* missing folder */
    }
  }
  out.add(process.cwd());
  return [...out].sort((a, b) => a.localeCompare(b)).slice(0, 60);
}

function killTree(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
  else child.kill('SIGTERM');
}

function startRun(r: Run, broadcast: (raw: Record<string, unknown>) => void) {
  const args = ['-p', '--output-format', 'json', '--permission-mode', r.permission === 'auto' ? 'auto' : 'acceptEdits'];
  const id = MODEL_IDS[r.model];
  if (id) args.push('--model', id);
  const child = spawn('claude', args, {
    cwd: r.project,
    env: { ...process.env, AGENT_OFFICE_RUN: r.runId, AGENT_OFFICE_SKIP: '' },
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  r.child = child;
  let out = '';
  let err = '';
  child.stdout?.on('data', (c) => (out += c));
  child.stderr?.on('data', (c) => (err += c));
  const finish = (ok: boolean, text: string) => {
    if (r.status !== 'running') return;
    r.status = ok ? 'done' : 'failed';
    r.endedAt = Date.now();
    r.result = text;
    r.child = undefined;
    broadcast({ hook_event_name: 'RunDone', session_id: r.session ?? 'run:' + r.runId, office_run: r.runId, ok, summary: text, cwd: r.project });
  };
  child.on('error', (e) => finish(false, `Could not start the claude CLI: ${e.message}`));
  child.on('close', () => {
    if (r.status === 'stopped') return;
    const last = out.trim().split('\n').pop() ?? '';
    try {
      const j = JSON.parse(last);
      if (j.session_id) r.session = j.session_id;
      if (typeof j.total_cost_usd === 'number') r.cost = j.total_cost_usd;
      const text = String(j.result ?? '').trim();
      finish(!j.is_error && !!text, text || 'The agent finished without a summary.');
    } catch {
      finish(false, (err || out || 'The run ended without output.').trim().slice(0, 600));
    }
  });
  // the task itself, plus a nudge to end with a short report for the manager
  child.stdin?.end(
    `${r.task}\n\nWhen you are done, end with a short report (2-4 sentences) for your manager: what you changed and anything they should check.`,
  );
}

export async function handleRuns(
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
  knownCwds: () => string[],
  broadcast: (raw: Record<string, unknown>) => void,
) {
  const send = (code: number, obj: unknown) => {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(obj));
  };
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (req.headers['x-agent-office'] !== '1' || (origin && host && new URL(origin).host !== host)) return send(403, { ok: false, error: 'forbidden' });
  const url = req.url ?? '';

  if (url.startsWith('/api/projects')) return send(200, { ok: true, projects: projectCandidates(knownCwds()) });
  if (url.startsWith('/api/models')) return send(200, { ok: true, default: defaultModel() });
  if (url.startsWith('/api/runs') && req.method === 'GET') return send(200, { ok: true, runs: [...runs.values()].map(publicRun).reverse() });

  let q: any = {};
  try {
    q = JSON.parse(body || '{}');
  } catch {
    return send(400, { ok: false, error: 'bad json' });
  }
  if (url.startsWith('/api/run/stop')) {
    const r = runs.get(String(q.runId));
    if (!r || r.status !== 'running') return send(404, { ok: false, error: 'not running' });
    r.status = 'stopped';
    r.endedAt = Date.now();
    r.result = 'Stopped by the manager.';
    if (r.child) killTree(r.child);
    broadcast({ hook_event_name: 'RunDone', session_id: r.session ?? 'run:' + r.runId, office_run: r.runId, ok: false, summary: 'Stopped by the manager.' });
    return send(200, { ok: true });
  }
  if (url.startsWith('/api/run')) {
    const project = path.resolve(String(q.project ?? ''));
    const task = String(q.task ?? '').trim();
    const runId = String(q.runId ?? '').replace(/[^\w-]/g, '').slice(0, 40);
    if (!runId || runs.has(runId)) return send(400, { ok: false, error: 'bad run id' });
    if (!task) return send(400, { ok: false, error: 'Write a task first.' });
    if (!fs.existsSync(project) || !fs.statSync(project).isDirectory()) return send(400, { ok: false, error: `Folder not found: ${project}` });
    if ([...runs.values()].filter((r) => r.status === 'running').length >= MAX_RUNS) return send(429, { ok: false, error: `At most ${MAX_RUNS} tasks at a time.` });
    const r: Run = {
      runId,
      project,
      model: String(q.model ?? 'default') in MODEL_IDS ? String(q.model ?? 'default') : 'default',
      permission: q.permission === 'auto' ? 'auto' : 'edit',
      task: task.slice(0, 4000),
      status: 'running',
      startedAt: Date.now(),
    };
    runs.set(runId, r);
    startRun(r, broadcast);
    return send(200, { ok: true, run: publicRun(r) });
  }
  send(404, { ok: false, error: 'unknown' });
}
