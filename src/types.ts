export interface OfficeEvent {
  id: number;
  t: number;
  kind: string;
  session: string;
  project: string;
  agentId?: string;
  agentType?: string;
  model?: string;
  subModel?: string;
  runId?: string;
  ok?: boolean;
  ask?: AskPayload & { how?: string };
  tool?: string;
  toolUseId?: string;
  detail?: string;
}

export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

/** A question (AskUserQuestion) or permission prompt waiting for the user's answer. */
export interface AskPayload {
  id: string;
  type: 'question' | 'permission';
  tool?: string;
  summary: string;
  questions?: AskQuestion[];
}

export type ActivityKind =
  | 'think'
  | 'read'
  | 'write'
  | 'run'
  | 'search'
  | 'web'
  | 'delegate'
  | 'todo'
  | 'mcp'
  | 'other';

export interface Activity {
  kind: ActivityKind;
  tool?: string;
  detail?: string;
}

export type Role = 'lead' | 'sub' | 'player';

export interface SpawnOptions {
  role: Role;
  name: string;
  subtitle: string;
  session: string;
  instant: boolean;
}

/** What the 3D office must be able to do. The director drives it from hook events. */
export interface Stage {
  has(id: string): boolean;
  spawn(id: string, opts: SpawnOptions): void;
  work(id: string, instant: boolean): void;
  activity(id: string, act: Activity): void;
  toolDone(id: string, failed?: boolean): void;
  idle(id: string, mood: 'happy' | 'sad', instant: boolean): void;
  leave(id: string, celebrate: boolean, instant: boolean): void;
  notify(id: string, text: string): void;
  rename(id: string, name: string, subtitle: string): void;
  setModel(id: string, model: string): void;
  /** A task dispatched from the manager desk finished: come back, report, leave. */
  report(id: string, ok: boolean, summary: string): void;
  ask(id: string, ask: AskPayload): void;
  clearAsk(askId: string, how: string): void;
}

/** "claude-opus-5-5" → "Opus 5.5", "haiku" → "Haiku", "glm-5.3" → "GLM 5.3". */
export function modelLabel(id?: string): string {
  if (!id) return '';
  const raw = id.replace(/\[.*\]$/, '').replace(/^(us|eu|apac)\.anthropic\./, '').replace(/^anthropic\//, '');
  const m = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?/i.exec(raw);
  if (m) return `${cap(m[1])} ${m[2]}${m[3] ? '.' + m[3] : ''}`;
  if (/^(opus|sonnet|haiku|fable|mythos)$/i.test(raw)) return cap(raw);
  const t = /^([a-z]+)[-_]?(\d[\w.]*)$/i.exec(raw);
  if (t) return `${t[1].length <= 4 ? t[1].toUpperCase() : cap(t[1])} ${t[2]}`;
  return raw;
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

export function toolKind(tool?: string): ActivityKind {
  if (!tool) return 'think';
  if (tool.startsWith('mcp__')) return 'mcp';
  switch (tool) {
    case 'Read':
      return 'read';
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'write';
    case 'Bash':
    case 'PowerShell':
    case 'Monitor':
      return 'run';
    case 'Grep':
    case 'Glob':
    case 'ToolSearch':
    case 'LS':
      return 'search';
    case 'WebFetch':
    case 'WebSearch':
      return 'web';
    case 'Agent':
    case 'Task':
    case 'SendMessage':
    case 'Workflow':
      return 'delegate';
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return 'todo';
    default:
      return 'other';
  }
}
