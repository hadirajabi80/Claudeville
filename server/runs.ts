// Real task runs dispatched from the manager's desk: `claude -p` in the chosen project folder.
// The run's own hooks report back to the office (tagged with AGENT_OFFICE_RUN), so the summoned
// character works at a desk like any other agent, then reports the result here.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildRunner, detectAgents, agentModels, type AgentKind } from './agents';
import { RunLog, claudeLine, codexLine } from './runlog';

export interface Run {
  runId: string;
  project: string;
  model: string;
  permission: 'edit' | 'auto' | 'readonly';
  /** which coding agent does the work (Claude by default) */
  agent?: AgentKind;
  /** team runs bring their own instructions (no generic report footer) */
  raw?: boolean;
  task: string;
  status: 'running' | 'done' | 'failed' | 'stopped';
  startedAt: number;
  endedAt?: number;
  session?: string;
  result?: string;
  cost?: number;
  child?: ChildProcess;
  /** called once when the run ends (done, failed or stopped) */
  onDone?: (ok: boolean, text: string) => void;
  /** the live conversation, for the chat panel */
  log: RunLog;
}

const runs = new Map<string, Run>();
/** agent session id -> run id, for agents whose activity is read from their logs (Codex) */
const sessionRuns = new Map<string, string>();

/** Which office run (if any) an agent session belongs to. */
export function runForSession(session: string): string | undefined {
  return sessionRuns.get(session);
}
const MAX_RUNS = 6;

const MODEL_IDS: Record<string, string | undefined> = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-4-5-20251001',
  fable: 'claude-fable-5-1',
  default: undefined,
};
/** A model name as given (alias or full id, e.g. glm-5.3 from a gateway), or 'default' if it looks wrong. */
const cleanModel = (m: unknown) => {
  const s = String(m ?? 'default').trim().slice(0, 80);
  return /^[\w.:/\[\]-]+$/.test(s) ? s : 'default';
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
  const { child: _c, log: _l, onDone: _d, ...rest } = r;
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

/**
 * Environment for agent runs: the user's environment minus Claudeville's own server settings.
 * (An inherited PORT=5199 once made a QA agent start the team's test server on the office's port.)
 */
function runEnv(runId: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, AGENT_OFFICE_RUN: runId, AGENT_OFFICE_SKIP: '' };
  for (const k of Object.keys(env)) if (/^(PORT|HOST|VITE_|npm_)/i.test(k) || k === 'NODE_ENV') delete env[k];
  return env;
}

function startRun(r: Run, broadcast: (raw: Record<string, unknown>) => void) {
  if (r.agent && r.agent !== 'claude') return startOther(r, broadcast);
  // stream the conversation as it happens, so the page can show it live
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  // read-only runs (team planning and review) can look at the code but never change it
  if (r.permission === 'readonly') args.push('--tools', 'Read', 'Grep', 'Glob');
  else args.push('--permission-mode', r.permission === 'auto' ? 'auto' : 'acceptEdits');
  const id = r.model in MODEL_IDS ? MODEL_IDS[r.model] : r.model;
  if (id) args.push('--model', id);
  r.log.add('info', `Claude · ${r.model === 'default' ? 'default model' : r.model} · ${r.permission === 'readonly' ? 'read only' : r.permission === 'auto' ? 'edit + run commands' : 'edit files'}`);
  const child = spawn('claude', args, {
    cwd: r.project,
    env: runEnv(r.runId),
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  r.child = child;
  let err = '';
  let partial = '';
  let final: ReturnType<typeof claudeLine>;
  child.stdout?.on('data', (c) => {
    const lines = (partial + String(c)).split('\n');
    partial = lines.pop() ?? '';
    for (const l of lines) final = claudeLine(l, r.log, (sid) => (r.session = sid)) ?? final;
  });
  child.stderr?.on('data', (c) => {
    err += String(c);
    if (err.length > 100_000) err = err.slice(-50_000);
  });
  const finish = (ok: boolean, text: string) => {
    if (r.status !== 'running') return;
    r.status = ok ? 'done' : 'failed';
    r.endedAt = Date.now();
    r.result = text;
    r.child = undefined;
    broadcast({ hook_event_name: 'RunDone', session_id: r.session ?? 'run:' + r.runId, office_run: r.runId, ok, summary: text, cwd: r.project });
    r.onDone?.(ok, text);
  };
  child.on('error', (e) => {
    r.log.add('error', `Could not start the claude CLI: ${e.message}`);
    finish(false, `Could not start the claude CLI: ${e.message}`);
  });
  child.on('close', () => {
    if (r.status === 'stopped') return;
    if (partial) final = claudeLine(partial, r.log, (sid) => (r.session = sid)) ?? final;
    if (final) {
      if (typeof final.cost === 'number') r.cost = final.cost;
      return finish(final.ok, final.text);
    }
    const text = (err || 'The run ended without output.').trim().slice(0, 600);
    r.log.add('error', text);
    finish(false, text);
  });
  // the task itself, plus a nudge to end with a short report for the manager
  child.stdin?.end(
    r.raw ? r.task : `${r.task}\n\nWhen you are done, end with a short report (2-4 sentences) for your manager: what you changed and anything they should check.`,
  );
}

/** Codex, Cursor or Z Code doing the task. */
function startOther(r: Run, broadcast: (raw: Record<string, unknown>) => void) {
  const finish = (ok: boolean, text: string) => {
    if (r.status !== 'running') return;
    r.status = ok ? 'done' : 'failed';
    r.endedAt = Date.now();
    r.result = text;
    r.child = undefined;
    broadcast({ hook_event_name: 'RunDone', session_id: r.session ?? 'run:' + r.runId, office_run: r.runId, ok, summary: text, cwd: r.project });
    r.onDone?.(ok, text);
  };
  const rn = buildRunner(r.agent!, { runId: r.runId, project: r.project, model: r.model, permission: r.permission, prompt: r.raw ? r.task : `${r.task}\n\nWhen you are done, end with a short report (2-4 sentences) for your manager: what you changed and anything they should check.` });
  if ('error' in rn) {
    r.log.add('error', rn.error);
    setTimeout(() => finish(false, rn.error), 1500); // let the character reach a desk first
    return;
  }
  r.log.add('info', `${detectAgents()[r.agent!].label} · ${r.model === 'default' ? 'default model' : r.model}`);
  const child = spawn(rn.cmd, rn.args, { cwd: r.project, env: runEnv(r.runId), shell: rn.shell, windowsHide: true });
  r.child = child;
  let out = '';
  let err = '';
  let partial = '';
  child.stdout?.on('data', (c) => {
    const text = String(c);
    out += text;
    if (out.length > 400_000) out = out.slice(-200_000);
    if (!rn.sessionFromLine) return void r.log.add('say', text); // plain-text agents: show what they print
    const lines = (partial + text).split('\n');
    partial = lines.pop() ?? '';
    for (const l of lines) {
      if (r.agent === 'codex') codexLine(l, r.log);
      const sid = rn.sessionFromLine(l);
      if (sid && !r.session) {
        r.session = sid;
        sessionRuns.set(sid, r.runId);
      }
    }
  });
  child.stderr?.on('data', (c) => {
    err += String(c);
    if (err.length > 100_000) err = err.slice(-50_000);
  });
  child.on('error', (e) => finish(false, `Could not start ${r.agent}: ${e.message}`));
  child.on('close', (code) => {
    if (r.status === 'stopped') return;
    let outText = '';
    try {
      if (rn.outFile && fs.existsSync(rn.outFile)) outText = fs.readFileSync(rn.outFile, 'utf8');
    } catch {
      /* ignore */
    }
    const res = rn.parse(code, out, err, outText);
    r.log.add(res.ok ? 'info' : 'error', res.ok ? 'Finished' : res.text);
    finish(res.ok, res.text);
  });
  if (rn.stdin !== undefined) child.stdin?.end(rn.stdin);
  else child.stdin?.end();
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
  if (url.startsWith('/api/agents')) {
    // availability plus every model each agent can use here (Claude's come from your gateway)
    const agents = detectAgents();
    const models = await agentModels(defaultModel());
    for (const k of Object.keys(agents) as AgentKind[]) (agents[k] as any).options = models[k];
    return send(200, { ok: true, agents });
  }
  if (url.startsWith('/api/run/log') && req.method === 'GET') {
    // a run's live conversation: entries after position `since`
    const u = new URL(url, 'http://x');
    const r = runs.get(String(u.searchParams.get('runId')));
    if (!r) return send(404, { ok: false, error: 'unknown run' });
    return send(200, { ok: true, status: r.status, agent: r.agent ?? 'claude', model: r.model, ...r.log.since(Number(u.searchParams.get('since') ?? 0) || 0) });
  }
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
    r.log.add('error', '■ Stopped by the manager.');
    if (r.child) killTree(r.child);
    broadcast({ hook_event_name: 'RunDone', session_id: r.session ?? 'run:' + r.runId, office_run: r.runId, ok: false, summary: 'Stopped by the manager.' });
    r.onDone?.(false, 'Stopped by the manager.');
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
    const agent = (['codex', 'cursor', 'zcode'].includes(q.agent) ? q.agent : 'claude') as AgentKind;
    const r: Run = {
      runId,
      project,
      agent,
      model: cleanModel(q.model),
      permission: q.permission === 'auto' ? 'auto' : q.permission === 'readonly' ? 'readonly' : 'edit',
      raw: !!q.raw,
      task: task.slice(0, 24000),
      status: 'running',
      startedAt: Date.now(),
      log: new RunLog(),
    };
    runs.set(runId, r);
    startRun(r, broadcast);
    return send(200, { ok: true, run: publicRun(r) });
  }
  send(404, { ok: false, error: 'unknown' });
}

/** Start a run from server code (team mode) and get a promise for its result. */
export function launchRun(
  o: { runId: string; project: string; model: string; permission: Run['permission']; task: string; raw?: boolean; agent?: AgentKind },
  broadcast: (raw: Record<string, unknown>) => void,
): Promise<{ ok: boolean; text: string; stopped: boolean }> {
  return new Promise((resolve) => {
    const r: Run = {
      runId: o.runId,
      project: o.project,
      model: cleanModel(o.model),
      agent: o.agent,
      permission: o.permission,
      raw: o.raw,
      task: o.task,
      status: 'running',
      startedAt: Date.now(),
      log: new RunLog(),
      onDone: (ok, text) => resolve({ ok, text, stopped: r.status === 'stopped' }),
    };
    runs.set(r.runId, r);
    startRun(r, broadcast);
  });
}

/** The office run (still running) that a Claude Code / Codex session belongs to, if any. */
export function runningRunForSession(session: string): string | undefined {
  const id = sessionRuns.get(session);
  if (id && runs.get(id)?.status === 'running') return id;
  for (const r of runs.values()) if (r.status === 'running' && r.session === session) return r.runId;
  return undefined;
}

/** Stop a run started by anyone. */
export function stopRun(runId: string, broadcast: (raw: Record<string, unknown>) => void) {
  const r = runs.get(runId);
  if (!r || r.status !== 'running') return;
  r.status = 'stopped';
  r.endedAt = Date.now();
  r.result = 'Stopped by the manager.';
  r.log.add('error', '■ Stopped by the manager.');
  if (r.child) killTree(r.child);
  broadcast({ hook_event_name: 'RunDone', session_id: r.session ?? 'run:' + r.runId, office_run: r.runId, ok: false, summary: 'Stopped by the manager.' });
  r.onDone?.(false, 'Stopped by the manager.');
}
