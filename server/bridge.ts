// Vite plugin that turns the dev/preview server into the live event bridge.
// Claude Code hooks POST raw hook JSON to /api/event; the page listens on /api/stream (SSE).
import type { Plugin, Connect } from 'vite';
import type { ServerResponse, IncomingMessage } from 'node:http';
import path from 'node:path';
import { handleChat, type SessionInfo } from './chat';
import { handleRuns } from './runs';
import fs from 'node:fs';

export interface OfficeEvent {
  id: number;
  t: number;
  kind: string; // hook_event_name
  session: string;
  project: string;
  agentId?: string;
  agentType?: string;
  /** model id of the agent this event belongs to (lead or subagent), when known */
  model?: string;
  /** for PreToolUse(Agent): the model requested for the subagent being launched */
  subModel?: string;
  /** set on events from tasks dispatched at the manager desk */
  runId?: string;
  ok?: boolean;
  tool?: string;
  toolUseId?: string;
  detail?: string;
}

const MAX_BUFFER = 300;
const buffer: OfficeEvent[] = [];
const clients = new Set<ServerResponse>();
let nextId = 1;
const sessions = new Map<string, SessionInfo>();
const sessionModel = new Map<string, string>();
const subModel = new Map<string, string>();
const lastModelCheck = new Map<string, number>();

/** Latest assistant model id written in a Claude Code transcript (reads only the tail). */
function modelFromTranscript(file?: string): string | undefined {
  if (!file || !fs.existsSync(file)) return undefined;
  try {
    const size = fs.statSync(file).size;
    const len = Math.min(size, 300_000);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"assistant"')) continue;
      const m = /"model":"([^"]+)"/.exec(lines[i]);
      if (m && m[1] !== '<synthetic>') return m[1];
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

/** Work out which model the event's agent runs on (cheap, throttled transcript peeks). */
function modelFor(raw: Record<string, any>): { model?: string; subModel?: string } {
  const sid = raw.session_id ? String(raw.session_id) : '';
  const now = Date.now();
  if (raw.model) sessionModel.set(sid, String(typeof raw.model === 'object' ? (raw.model.id ?? raw.model.display_name) : raw.model));
  const kind = String(raw.hook_event_name ?? '');
  const key = 's:' + sid;
  if ((!sessionModel.has(sid) || kind === 'UserPromptSubmit' || kind === 'Stop') && now - (lastModelCheck.get(key) ?? 0) > 3000) {
    lastModelCheck.set(key, now);
    const m = modelFromTranscript(raw.transcript_path);
    if (m) sessionModel.set(sid, m);
  }
  let model = sessionModel.get(sid);
  if (raw.agent_id) {
    const aid = String(raw.agent_id);
    if (!subModel.has(aid) && now - (lastModelCheck.get(aid) ?? 0) > 3000) {
      lastModelCheck.set(aid, now);
      const guess = raw.agent_transcript_path ?? (raw.transcript_path ? path.join(path.dirname(String(raw.transcript_path)), sid, 'subagents', `agent-${aid}.jsonl`) : undefined);
      const m = modelFromTranscript(guess);
      if (m) subModel.set(aid, m);
    }
    model = subModel.get(aid);
  }
  const sub = (raw.tool_name === 'Agent' || raw.tool_name === 'Task') && raw.tool_input?.model ? String(raw.tool_input.model) : undefined;
  return { model, subModel: sub };
}

/** Remember where each session lives so chat answers can read its transcript and files. */
function remember(raw: Record<string, any>) {
  const id = raw.session_id ? String(raw.session_id) : null;
  if (!id) return;
  let s = sessions.get(id);
  if (!s) sessions.set(id, (s = { subTranscripts: new Map() }));
  if (raw.cwd) s.cwd = String(raw.cwd);
  if (raw.transcript_path) s.transcript = String(raw.transcript_path);
  if (raw.agent_id && raw.agent_transcript_path) s.subTranscripts.set(String(raw.agent_id), String(raw.agent_transcript_path));
}

const clip = (s: unknown, n = 70): string => {
  const str = typeof s === 'string' ? s : s == null ? '' : JSON.stringify(s);
  const one = str.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
};
const base = (p: unknown) => (typeof p === 'string' ? (p.split(/[\\/]/).pop() ?? p) : '');

/** Summarize tool input to a short, safe label. Never forwards file contents. */
function describeTool(tool: string, input: Record<string, unknown> = {}): string {
  switch (tool) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return base(input.file_path);
    case 'NotebookEdit':
      return base(input.notebook_path);
    case 'Bash':
    case 'PowerShell':
      return clip(input.command, 60);
    case 'Grep':
    case 'Glob':
      return clip(input.pattern, 50);
    case 'WebFetch':
      try {
        return new URL(String(input.url)).host;
      } catch {
        return clip(input.url, 40);
      }
    case 'WebSearch':
      return clip(input.query, 50);
    case 'Agent':
    case 'Task':
      return clip(input.description ?? input.subagent_type ?? 'subagent', 50);
    case 'TodoWrite':
      return 'updating the todo list';
    case 'Skill':
      return clip(input.skill, 40);
    default:
      if (tool.startsWith('mcp__')) return tool.split('__').slice(2).join(' ') || tool;
      return '';
  }
}

export function normalize(raw: Record<string, any>): OfficeEvent {
  const kind = String(raw.hook_event_name ?? raw.kind ?? 'Unknown');
  const tool = raw.tool_name ? String(raw.tool_name) : undefined;
  let detail: string | undefined;
  if (tool) detail = describeTool(tool, raw.tool_input ?? {});
  else if (kind === 'UserPromptSubmit') detail = clip(raw.prompt, 80);
  else if (kind === 'Notification') detail = clip(raw.message, 80);
  else if (kind === 'SessionStart') detail = clip(raw.source, 20);
  else if (kind === 'RunDone') detail = String(raw.summary ?? '').slice(0, 1500);
  return {
    id: nextId++,
    t: Date.now(),
    kind,
    session: String(raw.session_id ?? 'unknown'),
    project: raw.cwd ? path.basename(String(raw.cwd)) : '',
    agentId: raw.agent_id ? String(raw.agent_id) : undefined,
    agentType: raw.agent_type ? String(raw.agent_type) : undefined,
    tool,
    toolUseId: raw.tool_use_id ? String(raw.tool_use_id) : undefined,
    runId: raw.office_run ? String(raw.office_run) : undefined,
    ok: typeof raw.ok === 'boolean' ? raw.ok : undefined,
    detail,
  };
}

function broadcast(ev: OfficeEvent) {
  buffer.push(ev);
  if (buffer.length > MAX_BUFFER) buffer.shift();
  const msg = `data: ${JSON.stringify(ev)}\n\n`;
  for (const c of clients) c.write(msg);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      data += c;
      if (data.length > 4_000_000) req.destroy();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const middleware: Connect.NextHandleFunction = async (req, res, next) => {
  const url = req.url ?? '';
  if (url.startsWith('/api/event') && req.method === 'POST') {
    try {
      const raw = JSON.parse((await readBody(req)) || '{}');
      remember(raw);
      broadcast({ ...normalize(raw), ...modelFor(raw) });
      res.statusCode = 204;
    } catch {
      res.statusCode = 400;
    }
    res.end();
    return;
  }
  if (url.startsWith('/api/projects') || url.startsWith('/api/models') || url.startsWith('/api/runs') || url.startsWith('/api/run')) {
    const body = req.method === 'POST' ? await readBody(req) : '';
    await handleRuns(req, res, body, () => [...sessions.values()].map((s) => s.cwd ?? ''), (raw) => broadcast({ ...normalize(raw), ...modelFor(raw) }));
    return;
  }
  if (url.startsWith('/api/chat') && req.method === 'POST') {
    const body = await readBody(req);
    await handleChat(req, res, body, sessions, buffer);
    return;
  }
  if (url.startsWith('/api/stream')) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    // Replay the recent past so a page refresh restores who is at their desk.
    const since = Date.now() - 10 * 60_000;
    res.write(`event: replay\ndata: ${JSON.stringify(buffer.filter((e) => e.t >= since))}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }
  if (url.startsWith('/api/health')) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, clients: clients.size, events: buffer.length }));
    return;
  }
  next();
};

export function agentBridge(): Plugin {
  return {
    name: 'claude-agent-bridge',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
