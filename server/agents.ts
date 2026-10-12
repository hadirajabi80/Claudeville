// The coding agents a Work-room team member can be, and how to run each one headlessly.
//   claude  -> `claude -p`                     (handled in runs.ts)
//   codex   -> `codex exec`                    (bundled with the Codex app, or on PATH)
//   cursor  -> `cursor-agent -p`               (Cursor's CLI, if installed)
//   zcode   -> `zcode --prompt`                (Z Code's CLI, if installed)
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type AgentKind = 'claude' | 'codex' | 'cursor' | 'zcode';

export interface AgentInfo {
  available: boolean;
  path?: string;
  label: string;
  hint: string;
  models: string[];
}

/** First executable with one of these names on PATH (respects Windows PATHEXT). */
function onPath(names: string[]): string | null {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase()) : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const n of names) {
      for (const e of ['', ...exts]) {
        const p = path.join(dir, n + e);
        try {
          if (fs.statSync(p).isFile()) return p;
        } catch {
          /* not here */
        }
      }
    }
  }
  return null;
}

function codexPath(): string | null {
  const home = os.homedir();
  for (const p of [path.join(home, '.codex', '.sandbox-bin', 'codex.exe'), path.join(home, '.codex', 'plugins', '.plugin-appserver', 'codex.exe')]) if (fs.existsSync(p)) return p;
  return onPath(['codex']);
}

function codexModels(): string[] {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'models_cache.json'), 'utf8'));
    const list = (j.models ?? []).map((m: any) => String(m.slug ?? m.id ?? m)).filter((s: string) => s && !/review|reserve/i.test(s));
    return ['default', ...list];
  } catch {
    return ['default'];
  }
}

/** Cursor's installer puts the CLI in %LOCALAPPDATA%\cursor-agent (found even before PATH is refreshed). */
function cursorPath(): string | null {
  const found = onPath(['cursor-agent']);
  if (found) return found;
  const dir = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'cursor-agent');
  for (const n of ['cursor-agent.exe', 'cursor-agent.cmd']) if (fs.existsSync(path.join(dir, n))) return path.join(dir, n);
  return null;
}

export function detectAgents(): Record<AgentKind, AgentInfo> {
  const claude = onPath(['claude']);
  const codex = codexPath();
  const cursor = cursorPath();
  const zcode = onPath(['zcode']);
  return {
    claude: { available: !!claude, path: claude ?? undefined, label: 'Claude', hint: 'Install Claude Code so the "claude" command works.', models: ['default', 'opus', 'sonnet', 'haiku', 'fable'] },
    codex: { available: !!codex, path: codex ?? undefined, label: 'ChatGPT · Codex', hint: 'Install the Codex app or CLI and sign in.', models: codexModels() },
    cursor: { available: !!cursor, path: cursor ?? undefined, label: 'Cursor', hint: 'Install Cursor’s command-line agent (cursor-agent) from cursor.com/cli.', models: ['default', 'auto'] },
    zcode: { available: !!zcode, path: zcode ?? undefined, label: 'Z Code', hint: 'Install the Z Code CLI so the "zcode" command works.', models: ['default'] },
  };
}

export interface Runner {
  cmd: string;
  args: string[];
  shell: boolean;
  stdin?: string;
  /** file the agent writes its final message to (Codex) */
  outFile?: string;
  /** learn the agent's session id from its live output (to link its log events to the right character) */
  sessionFromLine?: (line: string) => string | undefined;
  /** final answer + success, from whatever the agent printed */
  parse: (code: number | null, out: string, err: string, outFileText: string) => { ok: boolean; text: string };
}

const q = (a: string) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

/** Friendly versions of the errors people actually hit. */
function explain(kind: AgentKind, err: string): string {
  if (/refresh token|sign in again|log ?in|401|unauthori[sz]ed|not logged/i.test(err)) return `${detectAgents()[kind].label} isn’t signed in. Open it and sign in again, then retry.`;
  if (/not allowed to access model|model .*not (found|available)|unknown model/i.test(err)) return `${detectAgents()[kind].label} can’t use that model with your account. Pick another one.`;
  const lines = err.split('\n').map((l) => l.trim()).filter(Boolean);
  return (lines.filter((l) => /error/i.test(l)).pop() ?? lines.pop() ?? 'The agent stopped without an answer.').slice(0, 400);
}

export function buildRunner(
  kind: AgentKind,
  r: { runId: string; project: string; model: string; permission: 'readonly' | 'edit' | 'auto'; prompt: string },
): Runner | { error: string } {
  const info = detectAgents()[kind];
  if (!info.available || !info.path) return { error: `${info.label} can’t run tasks on this computer yet. ${info.hint}` };
  const exe = info.path;
  const shell = /\.(cmd|bat)$/i.test(exe);
  const model = r.model && r.model !== 'default' ? r.model : '';

  if (kind === 'codex') {
    const outFile = path.join(os.tmpdir(), `claudeville-${r.runId}.txt`);
    const args = ['exec', '--skip-git-repo-check', '--json', '-C', r.project, '-s', r.permission === 'readonly' ? 'read-only' : 'workspace-write', '-o', outFile];
    if (model) args.push('-m', model);
    args.push('-');
    return {
      cmd: shell ? q(exe) : exe,
      args: shell ? args.map(q) : args,
      shell,
      stdin: r.prompt,
      outFile,
      sessionFromLine: (line) => {
        try {
          const j = JSON.parse(line);
          const id = j.thread_id ?? j.session_id ?? (j.type === 'thread.started' ? j.id : undefined);
          return id ? 'codex:' + id : undefined;
        } catch {
          return undefined;
        }
      },
      parse: (code, out, err, outText) => {
        const text = outText.trim();
        if (code === 0 && text) return { ok: true, text };
        return { ok: false, text: explain('codex', err + '\n' + out) };
      },
    };
  }

  // Cursor and Z Code take the task as an argument: keep it in a file so long prompts survive the shell
  const taskFile = path.join(os.tmpdir(), `claudeville-${r.runId}-task.md`);
  fs.writeFileSync(taskFile, r.prompt, 'utf8');
  const instruction = `Your full task is written in the file ${taskFile}. Read it carefully and do exactly what it says, working in ${r.project}.`;
  const done = (k: AgentKind) => (code: number | null, out: string, err: string) => {
    const text = out.trim();
    if (code === 0 && text) return { ok: true, text: text.length > 4000 ? text.slice(-4000) : text };
    return { ok: false, text: explain(k, err + '\n' + out) };
  };
  if (kind === 'cursor') {
    const args = ['-p', '--output-format', 'text'];
    if (model) args.push('--model', model);
    if (r.permission !== 'readonly') args.push('--force');
    args.push(instruction);
    return { cmd: shell ? q(exe) : exe, args: shell ? args.map(q) : args, shell, parse: done('cursor') };
  }
  // zcode: headless runs default to auto-approve ("yolo"); pick an explicit mode instead
  const args = ['--prompt', instruction, '--mode', r.permission === 'readonly' ? 'plan' : r.permission === 'auto' ? 'build' : 'edit'];
  return { cmd: shell ? q(exe) : exe, args: shell ? args.map(q) : args, shell, parse: done('zcode') };
}

// ------------------------------------------------------------------ model lists for the pickers

/** A model in a picker: `ok` false means it is listed but can't run here, with `note` saying why. */
export interface ModelOption {
  id: string;
  label: string;
  ok: boolean;
  note?: string;
}

const CLAUDE_FAMILY: [string, string][] = [
  ['opus', 'Opus 5.5'],
  ['sonnet', 'Sonnet 5.5'],
  ['haiku', 'Haiku 4.5'],
  ['fable', 'Fable 5.1'],
];

/** Claude Code's gateway settings, if it talks to one (never returned to the page). */
function claudeGateway(): { base: string; token: string } | null {
  let env: Record<string, string> = {};
  try {
    env = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')).env ?? {};
  } catch {
    /* no settings */
  }
  const base = (env.ANTHROPIC_BASE_URL ?? process.env.ANTHROPIC_BASE_URL ?? '').replace(/\/+$/, '');
  const token = env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY ?? '';
  if (!base || /(^|\.)anthropic\.com$/i.test(new URL(base).host) || !token) return null;
  return { base, token };
}

/** The models a gateway offers (its /v1/models list). */
async function gatewayModels(g: { base: string; token: string }): Promise<string[] | null> {
  try {
    const r = await fetch(`${g.base}/v1/models?limit=200`, {
      headers: { 'x-api-key': g.token, authorization: `Bearer ${g.token}`, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    return (j.data ?? j.models ?? []).map((m: any) => String(m.id ?? m.name ?? m)).filter(Boolean);
  } catch {
    return null;
  }
}

/** Cursor's own model list (needs Cursor's CLI to be signed in). */
function cursorModels(exe: string | null): Promise<string[] | null> {
  if (!exe) return Promise.resolve(null);
  return new Promise((resolve) => {
    const shell = /\.(cmd|bat)$/i.test(exe);
    execFile(shell ? `"${exe}"` : exe, ['models'], { timeout: 20000, shell, windowsHide: true }, (err, out) => {
      if (err) return resolve(null);
      const ids = String(out)
        .split('\n')
        .map((l) => l.trim().split(/\s+/)[0]?.replace(/^[-*•]\s*/, ''))
        .filter((s) => s && /^[\w.:\[\]-]+$/.test(s) && !/^(available|models?|id)$/i.test(s));
      resolve(ids.length ? ids : null);
    });
  });
}

let modelCache: { at: number; value: Record<AgentKind, ModelOption[]> } | null = null;

/** Every model each agent can use on this PC, for the team and dispatch pickers (cached for a few minutes). */
export async function agentModels(claudeDefault: string | null): Promise<Record<AgentKind, ModelOption[]>> {
  if (modelCache && Date.now() - modelCache.at < 5 * 60_000) return modelCache.value;
  const def = (name: string | null): ModelOption => ({ id: 'default', label: name ? `Default (${name})` : 'Default', ok: true });

  // Claude: through a gateway only what it offers can run; signed in directly, the Claude family
  const gw = claudeGateway();
  const offered = gw ? await gatewayModels(gw) : null;
  const claude: ModelOption[] = [def(claudeDefault)];
  if (gw) {
    const host = new URL(gw.base).host;
    for (const id of offered ?? []) claude.push({ id, label: id, ok: true, note: `from ${host}` });
    for (const [id, label] of CLAUDE_FAMILY) {
      const full = offered?.find((m) => m.startsWith(`claude-${id}`));
      if (!full) claude.push({ id, label, ok: false, note: `not offered by ${host}` });
    }
  } else for (const [id, label] of CLAUDE_FAMILY) claude.push({ id, label, ok: true });

  const codex: ModelOption[] = codexModels().map((id) => (id === 'default' ? def(null) : { id, label: id, ok: true }));
  const fromCursor = await cursorModels(cursorPath());
  const cursor: ModelOption[] = fromCursor
    ? [def(null), ...fromCursor.map((id) => ({ id, label: id, ok: true }))]
    : [def(null), { id: 'auto', label: 'auto', ok: true }, ...['gpt-5', 'sonnet-4', 'sonnet-4-thinking'].map((id) => ({ id, label: id, ok: true, note: 'sign in to Cursor (agent login) to see your models' }))];
  const zcode: ModelOption[] = [def(null)];

  const value = { claude, codex, cursor, zcode };
  modelCache = { at: Date.now(), value };
  return value;
}
