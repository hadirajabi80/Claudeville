// Live activity from other coding agents, read from the logs they already write (no setup needed):
//   Codex (ChatGPT):  ~/.codex/sessions/**/rollout-*.jsonl   (structured session events)
//   Z Code:           ~/.zcode/cli/rollout/*.jsonl            (one record per model call)
// New lines are translated into the same hook-style events Claude Code sends, tagged with their source.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Emit = (raw: Record<string, unknown>) => void;

interface Tail {
  offset: number;
  partial: string;
  session: string;
  cwd?: string;
  model?: string;
  working: boolean;
  lastAt: number;
}

const clip = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Follow appended lines of jsonl files under a folder. Existing content is skipped (only new activity shows). */
function follow(dir: string, match: (file: string) => boolean, onLine: (file: string, t: Tail, j: any) => void, sessionOf: (file: string) => string) {
  const tails = new Map<string, Tail>();
  const read = (file: string, fromStart: boolean) => {
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      return;
    }
    let t = tails.get(file);
    if (!t) {
      t = { offset: fromStart ? 0 : st.size, partial: '', session: sessionOf(file), working: false, lastAt: Date.now() };
      tails.set(file, t);
      if (!fromStart) return;
    }
    if (st.size < t.offset) t.offset = 0; // truncated / rotated
    if (st.size === t.offset) return;
    const len = Math.min(st.size - t.offset, 4_000_000);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, t.offset);
    fs.closeSync(fd);
    t.offset += len;
    const text = t.partial + buf.toString('utf8');
    const lines = text.split('\n');
    t.partial = lines.pop() ?? '';
    for (const l of lines) {
      if (!l.trim()) continue;
      try {
        onLine(file, t, JSON.parse(l));
      } catch {
        /* skip bad line */
      }
    }
  };
  // remember the size of files that already exist, so only new activity is shown
  const scan = (d: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 4) scan(p, depth + 1);
      else if (e.isFile() && match(p)) read(p, false);
    }
  };
  if (!fs.existsSync(dir)) return () => {};
  scan(dir, 0);
  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(dir, { recursive: true }, (_ev, name) => {
      if (!name) return;
      const p = path.join(dir, String(name));
      if (match(p)) read(p, !tails.has(p));
    });
  } catch {
    /* recursive watch not supported: fall back to polling below */
  }
  // polling backstop (fs.watch can miss events on some file systems)
  const poll = setInterval(() => scan(dir, 0), 4000);
  poll.unref?.();
  return () => {
    watcher?.close();
    clearInterval(poll);
  };
}

// ---------------------------------------------------------------------------------- Codex (ChatGPT)

function codexSession(file: string) {
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(file);
  return 'codex:' + (m ? m[1] : path.basename(file));
}

function textOf(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => c?.text ?? '').join(' ');
  return '';
}

function codexTool(name: string, argsRaw: unknown): { tool: string; input: Record<string, unknown> } {
  let args: any = argsRaw;
  if (typeof argsRaw === 'string') {
    try {
      args = JSON.parse(argsRaw);
    } catch {
      args = { input: argsRaw };
    }
  }
  args = args ?? {};
  const cmd = Array.isArray(args.command) ? args.command.join(' ') : (args.command ?? args.cmd);
  switch (name) {
    case 'shell':
    case 'local_shell':
    case 'exec_command':
    case 'container.exec':
      return { tool: 'Bash', input: { command: String(cmd ?? '').replace(/^(bash|powershell(\.exe)?|pwsh)\s+(-lc|-Command)\s+/i, '') } };
    case 'apply_patch': {
      const patch = String(args.input ?? args.patch ?? '');
      const f = /\*\*\* (?:Update|Add|Delete) File: (.+)/.exec(patch)?.[1];
      return { tool: 'Edit', input: { file_path: f ?? 'files' } };
    }
    case 'update_plan':
      return { tool: 'TodoWrite', input: {} };
    case 'web_search':
      return { tool: 'WebSearch', input: { query: args.query } };
    case 'view_image':
      return { tool: 'Read', input: { file_path: args.path } };
    case 'spawn_agent':
      return { tool: 'Agent', input: { description: args.prompt ?? args.description ?? 'subagent' } };
    default:
      return { tool: name.includes('__') ? name : name, input: args };
  }
}

export function watchCodex(emit: Emit) {
  const dir = path.join(os.homedir(), '.codex', 'sessions');
  const base = (t: Tail) => ({ session_id: t.session, cwd: t.cwd, model: t.model, office_source: 'codex' });
  return follow(
    dir,
    (f) => /rollout-.*\.jsonl$/i.test(f),
    (_file, t, j) => {
      const p = j.payload ?? {};
      t.lastAt = Date.now();
      if (j.type === 'session_meta') {
        t.cwd = p.cwd ?? t.cwd;
        t.model = p.model ?? t.model;
        emit({ ...base(t), hook_event_name: 'SessionStart', source: 'startup' });
      } else if (j.type === 'turn_context') {
        t.cwd = p.cwd ?? t.cwd;
        t.model = p.model ?? t.model;
      } else if (j.type === 'response_item' && p.type === 'message' && p.role === 'user') {
        const text = textOf(p.content).trim();
        if (text && !text.startsWith('<')) {
          t.working = true;
          emit({ ...base(t), hook_event_name: 'UserPromptSubmit', prompt: text });
        }
      } else if (j.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call' || p.type === 'web_search_call')) {
        const name = p.type === 'local_shell_call' ? 'local_shell' : p.type === 'web_search_call' ? 'web_search' : String(p.name ?? 'tool');
        const { tool, input } = codexTool(name, p.arguments ?? p.input ?? p.action ?? {});
        if (!t.working) {
          t.working = true;
          emit({ ...base(t), hook_event_name: 'UserPromptSubmit', prompt: '' });
        }
        emit({ ...base(t), hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: p.call_id ?? p.id });
      } else if (j.type === 'response_item' && (p.type === 'function_call_output' || p.type === 'custom_tool_call_output')) {
        emit({ ...base(t), hook_event_name: 'PostToolUse', tool_name: 'tool', tool_use_id: p.call_id });
      } else if (j.type === 'event_msg' && p.type === 'task_started') {
        t.working = true;
      } else if (j.type === 'event_msg' && (p.type === 'task_complete' || p.type === 'turn_aborted')) {
        t.working = false;
        emit({ ...base(t), hook_event_name: p.type === 'task_complete' ? 'Stop' : 'StopFailure' });
      }
    },
    codexSession,
  );
}

// ---------------------------------------------------------------------------------- Z Code

/** Find tool calls in a model response, whatever its wire format (Anthropic or OpenAI style). */
function toolCalls(resp: unknown): { name: string; input: any }[] {
  const out: { name: string; input: any }[] = [];
  const walk = (o: any, depth: number) => {
    if (!o || typeof o !== 'object' || depth > 8) return;
    if (Array.isArray(o)) return o.forEach((x) => walk(x, depth + 1));
    if (o.type === 'tool_use' && o.name) out.push({ name: String(o.name), input: o.input ?? {} });
    else if (o.function?.name) {
      let input: any = o.function.arguments;
      try {
        input = typeof input === 'string' ? JSON.parse(input) : input;
      } catch {
        /* keep raw */
      }
      out.push({ name: String(o.function.name), input: input ?? {} });
    } else for (const v of Object.values(o)) walk(v, depth + 1);
  };
  walk(resp, 0);
  return out;
}

const ZCODE_TOOLS: Record<string, string> = {
  bash: 'Bash',
  shell: 'Bash',
  read: 'Read',
  read_file: 'Read',
  write: 'Write',
  write_file: 'Write',
  edit: 'Edit',
  edit_file: 'Edit',
  multiedit: 'Edit',
  grep: 'Grep',
  glob: 'Glob',
  ls: 'Glob',
  webfetch: 'WebFetch',
  web_fetch: 'WebFetch',
  websearch: 'WebSearch',
  web_search: 'WebSearch',
  todowrite: 'TodoWrite',
  task: 'Agent',
};

export function watchZcode(emit: Emit) {
  const dir = path.join(os.homedir(), '.zcode', 'cli', 'rollout');
  return follow(
    dir,
    (f) => /\.jsonl$/i.test(f),
    (_file, t, j) => {
      if (j.type !== 'model_io') return;
      const session = 'zcode:' + String(j.sessionId ?? t.session);
      const base = { session_id: session, model: j.model, office_source: 'zcode', cwd: t.cwd };
      if (!t.working) {
        t.working = true;
        emit({ ...base, hook_event_name: 'UserPromptSubmit', prompt: '' });
      }
      const calls = toolCalls(j.response);
      for (const c of calls) {
        const tool = ZCODE_TOOLS[c.name.toLowerCase()] ?? c.name;
        emit({ ...base, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path: c.input?.file_path ?? c.input?.path, command: c.input?.command, pattern: c.input?.pattern, query: c.input?.query, url: c.input?.url, description: c.input?.description } });
      }
      // a model call that asks for no tools ends the turn
      if (!calls.length) {
        t.working = false;
        emit({ ...base, hook_event_name: 'Stop' });
      }
    },
    (f) => 'zcode:' + (/sess_([0-9a-f-]+)/i.exec(f)?.[1] ?? path.basename(f)),
  );
}

// ---------------------------------------------------------------------------------- Cursor (hooks)

/** Cursor's hooks use their own names and fields: turn them into Claude-style events. */
export function fromCursor(raw: Record<string, any>): Record<string, any> | null {
  const ev = String(raw.hook_event_name ?? '');
  const base = {
    session_id: 'cursor:' + String(raw.conversation_id ?? raw.session_id ?? 'session'),
    cwd: Array.isArray(raw.workspace_roots) ? raw.workspace_roots[0] : raw.cwd,
    model: raw.model,
    office_source: 'cursor',
    office_run: raw.office_run,
  };
  switch (ev) {
    case 'sessionStart':
      return { ...base, hook_event_name: 'SessionStart', source: 'startup' };
    case 'sessionEnd':
      return { ...base, hook_event_name: 'SessionEnd' };
    case 'beforeSubmitPrompt':
      return { ...base, hook_event_name: 'UserPromptSubmit', prompt: clip(raw.prompt, 400) };
    case 'afterShellExecution':
    case 'beforeShellExecution':
      return { ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: raw.command } };
    case 'afterFileEdit':
      return { ...base, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: raw.file_path } };
    case 'beforeReadFile':
      return { ...base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: raw.file_path } };
    case 'afterMCPExecution':
    case 'beforeMCPExecution':
      return { ...base, hook_event_name: 'PreToolUse', tool_name: `mcp__${raw.server ?? raw.server_name ?? 'mcp'}__${raw.tool_name ?? 'tool'}`, tool_input: {} };
    case 'postToolUse':
    case 'preToolUse':
      return { ...base, hook_event_name: 'PreToolUse', tool_name: String(raw.tool_name ?? 'tool'), tool_input: raw.tool_input ?? {} };
    case 'subagentStart':
      return { ...base, hook_event_name: 'SubagentStart', agent_id: raw.subagent_id ?? raw.agent_id, agent_type: raw.subagent_type ?? raw.agent_type };
    case 'subagentStop':
      return { ...base, hook_event_name: 'SubagentStop', agent_id: raw.subagent_id ?? raw.agent_id };
    case 'stop':
      return { ...base, hook_event_name: 'Stop' };
    default:
      return null;
  }
}
