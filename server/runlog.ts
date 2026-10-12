// The live conversation of a run, as the page shows it in its chat panel: what the agent says, the tools it
// uses (files read and edited, commands run), what came back, and the final report. Built from the agent's
// streamed JSON output (Claude Code's stream-json, Codex's --json events) or, failing that, its plain text.

export interface LogEntry {
  /** say: the agent talking · tool: a tool call · out: what a tool returned · info: start/finish notes · error */
  kind: 'say' | 'tool' | 'out' | 'info' | 'error';
  text: string;
  t: number;
}

const MAX_ENTRIES = 600;
const MAX_TEXT = 4000;

export class RunLog {
  readonly entries: LogEntry[] = [];
  /** entries dropped from the front once the log got long (keeps "since" offsets stable) */
  dropped = 0;

  add(kind: LogEntry['kind'], text: string) {
    const s = text.trim();
    if (!s) return;
    this.entries.push({ kind, text: s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '…' : s, t: Date.now() });
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.shift();
      this.dropped++;
    }
  }

  /** Entries after position `since` (positions count every entry ever added). */
  since(since: number) {
    const from = Math.max(0, since - this.dropped);
    return { entries: this.entries.slice(from), next: this.dropped + this.entries.length };
  }
}

const short = (v: unknown, n = 160) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

/** One line for a tool call, the way a person would describe it. */
export function describeTool(name: string, input: Record<string, any> = {}): string {
  const file = input.file_path ?? input.path ?? input.notebook_path;
  switch (name) {
    case 'Read':
      return `📖 Read ${file ?? ''}`;
    case 'Write':
      return `📝 Write ${file ?? ''}`;
    case 'Edit':
    case 'MultiEdit':
      return `✏️ Edit ${file ?? ''}`;
    case 'Bash':
    case 'PowerShell':
      return `💻 ${short(input.command, 220)}`;
    case 'Grep':
      return `🔎 Search for "${short(input.pattern, 80)}"${input.path ? ' in ' + input.path : ''}`;
    case 'Glob':
      return `🔎 Find files ${short(input.pattern, 80)}`;
    case 'WebFetch':
      return `🌐 Open ${short(input.url, 120)}`;
    case 'WebSearch':
      return `🌐 Search the web for "${short(input.query, 100)}"`;
    case 'TodoWrite':
      return `🗒️ Update the to-do list (${Array.isArray(input.todos) ? input.todos.length : 0} items)`;
    case 'Task':
    case 'Agent':
      return `🤝 Ask a helper: ${short(input.description ?? input.prompt, 120)}`;
    default:
      return `🔧 ${name} ${short(input, 140)}`;
  }
}

/** What a tool returned, trimmed to something readable. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c: any) => (c?.type === 'text' ? c.text : '')).join('\n');
  return '';
}

export interface ClaudeFinal {
  ok: boolean;
  text: string;
  session?: string;
  cost?: number;
}

/** One line of `claude -p --output-format stream-json --verbose`. Returns the final result when it arrives. */
export function claudeLine(line: string, log: RunLog, onSession: (id: string) => void): ClaudeFinal | undefined {
  let j: any;
  try {
    j = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (j.session_id) onSession(j.session_id);
  if (j.type === 'system' && j.subtype === 'init') {
    log.add('info', `Started${j.model ? ' · ' + j.model : ''}${j.cwd ? ' · ' + j.cwd : ''}`);
  } else if (j.type === 'assistant') {
    for (const c of j.message?.content ?? []) {
      if (c.type === 'text') log.add('say', c.text);
      else if (c.type === 'tool_use') log.add('tool', describeTool(c.name, c.input));
    }
  } else if (j.type === 'user') {
    for (const c of j.message?.content ?? []) {
      if (c.type !== 'tool_result') continue;
      const text = toolResultText(c.content).trim();
      if (c.is_error) log.add('error', text || 'The tool failed.');
      else if (text) log.add('out', text.length > 600 ? text.slice(0, 600) + '…' : text);
    }
  } else if (j.type === 'result') {
    const text = String(j.result ?? '').trim();
    const ok = !j.is_error && !!text;
    log.add(ok ? 'info' : 'error', ok ? `Finished${typeof j.total_cost_usd === 'number' ? ` · $${j.total_cost_usd.toFixed(3)}` : ''}` : text || 'The run failed.');
    return { ok, text: text || 'The agent finished without a summary.', session: j.session_id, cost: j.total_cost_usd };
  }
  return undefined;
}

/** One line of `codex exec --json`. */
export function codexLine(line: string, log: RunLog) {
  let j: any;
  try {
    j = JSON.parse(line);
  } catch {
    return;
  }
  const item = j.item ?? j.msg ?? {};
  const type = item.type ?? item.item_type;
  if (j.type === 'thread.started') log.add('info', 'Started');
  else if (j.type === 'item.started' && type === 'command_execution') log.add('tool', `💻 ${short(item.command, 220)}`);
  else if (j.type === 'item.completed') {
    if (type === 'agent_message' || type === 'assistant_message') log.add('say', item.text ?? '');
    else if (type === 'command_execution' && item.aggregated_output) log.add(item.exit_code ? 'error' : 'out', short(item.aggregated_output, 600));
    else if (type === 'file_change') for (const ch of item.changes ?? []) log.add('tool', `✏️ ${ch.kind ?? 'Change'} ${ch.path ?? ''}`);
    else if (type === 'web_search') log.add('tool', `🌐 Search the web for "${short(item.query, 100)}"`);
    else if (type === 'error') log.add('error', item.message ?? '');
  } else if (j.type === 'turn.failed' || j.type === 'error') log.add('error', j.error?.message ?? j.message ?? 'The run failed.');
}
