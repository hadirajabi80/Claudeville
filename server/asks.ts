// Questions and permission prompts from agents, answered inside Claudeville.
// The ask hook long-polls /api/ask; the page answers through /api/answer.
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

export interface AskPayload {
  id: string;
  type: 'question' | 'permission';
  tool?: string;
  summary: string;
  questions?: AskQuestion[];
}

interface Pending {
  ask: AskPayload;
  raw: Record<string, any>;
  res: ServerResponse;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, Pending>();
let lastVisible = 0;
const WAIT_MS = 4 * 60_000; // how long an agent waits for you in the office before asking in Claude Code
let nextAsk = 1;

const clip = (s: unknown, n: number) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/** Short human description of what a permission prompt is about. */
function permissionSummary(tool: string, input: Record<string, any>): string {
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return `Run: ${clip(input.command, 160)}`;
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `${tool === 'Write' ? 'Write' : 'Edit'} ${clip(input.file_path ?? input.notebook_path, 120)}`;
    case 'WebFetch':
      return `Open ${clip(input.url, 120)}`;
    case 'WebSearch':
      return `Search the web for “${clip(input.query, 100)}”`;
    default:
      return `Use ${tool.startsWith('mcp__') ? tool.split('__').slice(1).join(' › ') : tool}`;
  }
}

export function markVisible(visible: boolean) {
  if (visible) lastVisible = Date.now();
}

function hasViewer() {
  return Date.now() - lastVisible < 25_000;
}

/** Hook side: register the question, tell the page, and hold the request until answered. */
export function handleAsk(req: IncomingMessage, res: ServerResponse, body: string, broadcast: (raw: Record<string, unknown>) => void) {
  const json = (obj: unknown) => {
    if (res.writableEnded) return;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(obj));
  };
  let raw: Record<string, any>;
  try {
    raw = JSON.parse(body || '{}');
  } catch {
    return json({ why: 'bad-json' });
  }
  if (!hasViewer()) return json({ why: 'no-viewer' }); // nobody is watching the office: ask in Claude Code right away
  const kind = String(raw.hook_event_name ?? '');
  const tool = String(raw.tool_name ?? '');
  const input = raw.tool_input ?? {};
  let ask: AskPayload;
  const id = `ask${Date.now().toString(36)}${nextAsk++}`;
  if (kind === 'PreToolUse' && tool === 'AskUserQuestion' && Array.isArray(input.questions)) {
    const questions: AskQuestion[] = input.questions.map((q: any) => ({
      question: String(q.question ?? ''),
      header: q.header ? String(q.header) : undefined,
      multiSelect: !!q.multiSelect,
      options: Array.isArray(q.options) ? q.options.map((o: any) => ({ label: String(o.label ?? ''), description: o.description ? String(o.description) : undefined })) : [],
    }));
    ask = { id, type: 'question', tool, summary: clip(questions[0]?.question, 140), questions };
  } else if (kind === 'PermissionRequest') {
    ask = { id, type: 'permission', tool, summary: permissionSummary(tool, input) };
  } else return json({ why: 'not-a-question' });

  const p: Pending = {
    ask,
    raw,
    res,
    timer: setTimeout(() => finish(id, null, broadcast, 'timeout'), WAIT_MS),
  };
  pending.set(id, p);
  // the hook went away (e.g. the user pressed Esc in Claude Code). Note: watch the response,
  // not the request: a request's 'close' fires as soon as its body has been read.
  res.on('close', () => {
    if (!res.writableEnded && pending.has(id)) finish(id, null, broadcast, 'cancelled');
  });
  void req;
  broadcast({ ...raw, hook_event_name: 'Ask', ask });
}

/** Resolve a pending question. `answer` null means "let Claude Code ask normally". */
function finish(id: string, output: unknown | null, broadcast: (raw: Record<string, unknown>) => void, how: string) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  clearTimeout(p.timer);
  if (!p.res.writableEnded) {
    p.res.setHeader('Content-Type', 'application/json');
    p.res.end(JSON.stringify(output ?? { why: how }));
  }
  broadcast({ session_id: p.raw.session_id, agent_id: p.raw.agent_id, cwd: p.raw.cwd, hook_event_name: 'AskDone', ask: { id, how } });
}

/** Page side: the user's answer. */
export function handleAnswer(res: ServerResponse, body: string, broadcast: (raw: Record<string, unknown>) => void) {
  const json = (code: number, obj: unknown) => {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(obj));
  };
  let q: any;
  try {
    q = JSON.parse(body || '{}');
  } catch {
    return json(400, { ok: false });
  }
  const p = pending.get(String(q.id));
  if (!p) return json(404, { ok: false, error: 'This question was already answered or has expired.' });
  if (q.release) {
    finish(p.ask.id, null, broadcast, 'released');
    return json(200, { ok: true });
  }
  let output: unknown;
  if (p.ask.type === 'permission') {
    output = {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: q.allow ? { behavior: 'allow' } : { behavior: 'deny', message: String(q.message || 'The user said no (answered in Claudeville).') },
      },
    };
  } else {
    // pre-fill the answers so AskUserQuestion returns them without showing its own dialog
    const answers: Record<string, string> = {};
    for (const [k, v] of Object.entries(q.answers ?? {})) answers[String(k)] = String(v);
    output = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'Answered by the user in Claudeville',
        updatedInput: { ...(p.raw.tool_input ?? {}), answers },
      },
    };
  }
  finish(p.ask.id, output, broadcast, 'answered');
  json(200, { ok: true });
}

/** Open questions with who asked them (lets a reloaded page put the raised hands back). */
export function pendingAsks() {
  return [...pending.values()].map((p) => ({ ...p.ask, session: String(p.raw.session_id ?? ''), agentId: p.raw.agent_id ? String(p.raw.agent_id) : undefined }));
}
