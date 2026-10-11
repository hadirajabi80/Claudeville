// Answers questions the user asks an agent in the office, by running a short read-only `claude -p`.
// Context = the agent's recent hook activity + the tail of its real session transcript, so replies
// know what the agent has actually been doing. Tools are limited to Read/Grep/Glob: it can look, never touch.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface SessionInfo {
  cwd?: string;
  transcript?: string;
  subTranscripts: Map<string, string>; // agent_id -> transcript path
}

export interface ChatEventLine {
  t: number;
  kind: string;
  session: string;
  agentId?: string;
  tool?: string;
  detail?: string;
}

interface ChatRequest {
  session: string;
  agentId?: string; // Claude Code agent_id for subagents
  name: string;
  role: 'lead' | 'sub';
  subtitle?: string;
  activity?: string;
  question: string;
  history?: { from: 'user' | 'agent'; text: string }[];
  recent?: string[]; // activity lines tracked by the page (covers demo agents)
}

const MAX_PARALLEL = 2;
let running = 0;

/** Last few human/assistant text messages from a Claude Code JSONL transcript. */
function transcriptTail(file: string | undefined, maxMsgs = 10): string {
  if (!file || !fs.existsSync(file)) return '';
  try {
    const size = fs.statSync(file).size;
    const len = Math.min(size, 400_000);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').slice(1);
    const out: string[] = [];
    for (const line of lines) {
      let j: any;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      const msg = j.message;
      if (!msg || (j.type !== 'user' && j.type !== 'assistant')) continue;
      let text = '';
      if (typeof msg.content === 'string') text = msg.content;
      else if (Array.isArray(msg.content)) text = msg.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n');
      text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
      if (!text || text.startsWith('<')) continue;
      out.push(`${j.type === 'user' ? 'USER' : 'AGENT'}: ${text.length > 700 ? text.slice(0, 700) + ' …' : text}`);
    }
    return out.slice(-maxMsgs).join('\n\n');
  } catch {
    return '';
  }
}

function buildPrompt(req: ChatRequest, info: SessionInfo | undefined, events: ChatEventLine[]) {
  const mine = events
    .filter((e) => e.session === req.session && (req.role === 'lead' ? !e.agentId : !req.agentId || e.agentId === req.agentId))
    .slice(-30)
    .map((e) => `${new Date(e.t).toLocaleTimeString()} ${e.kind}${e.tool ? ' ' + e.tool : ''}${e.detail ? ' — ' + e.detail : ''}`)
    .join('\n') || (req.recent ?? []).slice(-30).map(String).join('\n');
  const tx = transcriptTail(req.role === 'sub' && req.agentId ? (info?.subTranscripts.get(req.agentId) ?? info?.transcript) : info?.transcript);
  const project = info?.cwd ? path.basename(info.cwd) : 'unknown project';
  const who =
    req.role === 'lead'
      ? `You are ${req.name}, the lead Claude Code agent of a session working in the project "${project}".`
      : `You are ${req.name}, a Claude Code subagent (${req.subtitle ?? 'helper'}) spawned by the lead agent of a session in the project "${project}".`;
  const hist = (req.history ?? [])
    .slice(-8)
    .map((h) => `${h.from === 'user' ? 'Human' : req.name}: ${h.text}`)
    .join('\n');
  return [
    who,
    'You appear as a cute character in the user\'s 3D "Agent Office" visualization. Your human just walked up to your desk and asked you something.',
    'Answer in the first person, warmly and concisely (at most ~120 words), as the agent who has been doing this work.',
    /[؀-ۿ]/.test(req.question)
      ? 'The human wrote in Persian: answer in natural, friendly Persian (Farsi).'
      : 'The human wrote in English: answer in English, even if the context below is in another language.',
    'Base your answer on the context below. You may use Read, Grep and Glob to look at project files if that helps, but never suggest you changed anything. If you do not know, say so honestly.',
    '',
    `Current status: ${req.activity || 'idle'}`,
    mine ? `\nYour recent actions (from Claude Code hooks):\n${mine}` : '',
    tx ? `\nRecent conversation in your session (most recent last):\n${tx}` : '',
    hist ? `\nChat so far in the office:\n${hist}` : '',
    `\nHuman: ${req.question}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function runClaude(prompt: string, cwd: string): Promise<{ ok: boolean; text: string; ms: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const args = ['-p', '--output-format', 'json', '--no-session-persistence'];
    if (process.env.AGENT_OFFICE_CHAT_MODEL) args.push('--model', process.env.AGENT_OFFICE_CHAT_MODEL);
    args.push('--tools', 'Read', 'Grep', 'Glob');
    const child = spawn('claude', args, {
      cwd,
      env: { ...process.env, AGENT_OFFICE_SKIP: '1' },
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, text: 'The agent took too long to answer (timeout).', ms: Date.now() - started });
    }, 120_000);
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, text: `Could not start the claude CLI: ${e.message}`, ms: Date.now() - started });
    });
    child.on('close', () => {
      clearTimeout(timer);
      const last = out.trim().split('\n').pop() ?? '';
      try {
        const j = JSON.parse(last);
        const text = String(j.result ?? '').trim();
        if (j.is_error || !text) resolve({ ok: false, text: text || 'Empty answer.', ms: Date.now() - started });
        else resolve({ ok: true, text, ms: Date.now() - started });
      } catch {
        resolve({ ok: false, text: (err || out || 'No answer.').trim().slice(0, 400), ms: Date.now() - started });
      }
    });
    child.stdin.end(prompt);
  });
}

export async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
  sessions: Map<string, SessionInfo>,
  events: ChatEventLine[],
) {
  const send = (code: number, obj: unknown) => {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(obj));
  };
  // only the office page itself may ask (blocks other websites from triggering runs)
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (req.headers['x-agent-office'] !== '1' || (origin && host && new URL(origin).host !== host)) return send(403, { ok: false, error: 'forbidden' });
  let q: ChatRequest;
  try {
    q = JSON.parse(body);
  } catch {
    return send(400, { ok: false, error: 'bad json' });
  }
  if (!q.question?.trim()) return send(400, { ok: false, error: 'empty question' });
  if (running >= MAX_PARALLEL) return send(429, { ok: false, error: 'Agents are busy answering other questions, try again in a moment.' });
  running++;
  try {
    const info = sessions.get(q.session);
    const cwd = info?.cwd && fs.existsSync(info.cwd) ? info.cwd : process.cwd();
    const r = await runClaude(buildPrompt(q, info, events), cwd);
    send(200, r.ok ? { ok: true, answer: r.text, ms: r.ms } : { ok: false, error: r.text, ms: r.ms });
  } finally {
    running--;
  }
}
