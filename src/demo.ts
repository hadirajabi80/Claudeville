// A scripted run that feeds fake hook events through the same pipeline as the real ones.
import type { OfficeEvent } from './types';

type Step = [number, Partial<OfficeEvent>];

export function demoScript(): Step[] {
  const A = 'demo-' + Math.random().toString(36).slice(2, 8);
  const B = 'demo-' + Math.random().toString(36).slice(2, 8);
  const a1 = A + '-scout';
  const a2 = A + '-arch';
  const a3 = B + '-help';
  const pa = { session: A, project: 'agent-office', model: 'claude-opus-5-5' };
  const pb = { session: B, project: 'lantern-bureau', model: 'claude-sonnet-5-5' };
  const tool = (t: number, base: object, tool: string, detail: string, extra: Partial<OfficeEvent> = {}, dur = 2.2): Step[] => [
    [t, { ...base, kind: 'PreToolUse', tool, detail, ...extra }],
    [t + dur, { ...base, kind: 'PostToolUse', tool, detail, ...extra }],
  ];
  return [
    [0, { ...pa, kind: 'SessionStart', detail: 'startup' }],
    [2.5, { ...pa, kind: 'UserPromptSubmit', detail: 'Build a 3D office where my agents work' }],
    [3, { ...pb, kind: 'SessionStart', detail: 'startup' }],
    ...tool(6, pa, 'Read', 'src/main.ts'),
    [6.5, { ...pb, kind: 'UserPromptSubmit', detail: 'Fix the lantern puzzle bug' }],
    ...tool(8.6, pa, 'Grep', '"Agent" in src/'),
    ...tool(10, pb, 'Read', 'puzzle.ts', {}, 3),
    [11, { ...pa, kind: 'PreToolUse', tool: 'Agent', detail: 'Explore the codebase', toolUseId: 'tu1' }],
    [11.4, { ...pa, kind: 'SubagentStart', agentId: a1, agentType: 'Explore' }],
    [12, { ...pa, kind: 'PreToolUse', tool: 'Agent', detail: 'Design the animation spec', toolUseId: 'tu2' }],
    [12.4, { ...pa, kind: 'SubagentStart', agentId: a2, agentType: 'Plan' }],
    [12.6, { ...pa, kind: 'PostToolUse', tool: 'Agent', toolUseId: 'tu1' }],
    [12.8, { ...pa, kind: 'PostToolUse', tool: 'Agent', toolUseId: 'tu2' }],
    ...tool(14, pb, 'Edit', 'puzzle.ts', {}, 4),
    ...tool(18.5, { ...pa, agentId: a1, model: 'claude-haiku-4-5-20251001' }, 'Glob', '**/*.ts'),
    ...tool(19, { ...pa, agentId: a2, model: 'claude-fable-5-1' }, 'WebSearch', 'procedural walk cycle'),
    ...tool(15, pa, 'Write', 'src/agent.ts', {}, 5),
    ...tool(19.5, pb, 'Bash', 'npm test', {}, 4.5),
    ...tool(21.5, { ...pa, agentId: a1, model: 'claude-haiku-4-5-20251001' }, 'Read', 'world.ts', {}, 3),
    ...tool(22, { ...pa, agentId: a2, model: 'claude-fable-5-1' }, 'Read', 'pose.ts', {}, 3),
    [21, { ...pa, kind: 'PreToolUse', tool: 'Bash', detail: 'npm run build' }],
    [22.5, { ...pa, kind: 'Notification', detail: 'Claude needs your permission to use Bash' }],
    [27, { ...pa, kind: 'PostToolUse', tool: 'Bash', detail: 'npm run build' }],
    [24.5, { ...pb, kind: 'PreToolUse', tool: 'Agent', detail: 'Write regression tests', toolUseId: 'tu3' }],
    [25, { ...pb, kind: 'SubagentStart', agentId: a3, agentType: 'general-purpose' }],
    ...tool(26.5, { ...pa, agentId: a1, model: 'claude-haiku-4-5-20251001' }, 'Grep', 'SubagentStop', {}, 2),
    [29, { ...pa, kind: 'SubagentStop', agentId: a1, agentType: 'Explore' }],
    ...tool(28.5, { ...pb, agentId: a3, model: 'claude-haiku-4-5-20251001' }, 'Write', 'puzzle.test.ts', {}, 4),
    ...tool(28, pa, 'Edit', 'src/office.ts', {}, 4),
    ...tool(27, { ...pa, agentId: a2, model: 'claude-fable-5-1' }, 'Write', 'docs/spec.md', {}, 4.5),
    [33, { ...pa, kind: 'SubagentStop', agentId: a2, agentType: 'Plan' }],
    ...tool(33, { ...pb, agentId: a3, model: 'claude-haiku-4-5-20251001' }, 'Bash', 'npm test -- puzzle', {}, 3.5),
    [37.5, { ...pb, kind: 'SubagentStop', agentId: a3, agentType: 'general-purpose' }],
    ...tool(32.5, pa, 'TodoWrite', '', {}, 1),
    ...tool(34, pa, 'WebFetch', 'threejs.org', {}, 3),
    ...tool(37.5, pa, 'Edit', 'README.md', {}, 2.5),
    [39, { ...pb, kind: 'Stop' }],
    [41, { ...pa, kind: 'Stop' }],
    [56, { ...pb, kind: 'SessionEnd' }],
    [68, { ...pa, kind: 'SessionEnd' }],
  ];
}

export class Demo {
  private timers: number[] = [];
  running = false;

  constructor(private feed: (e: OfficeEvent) => void) {}

  start(onEnd: () => void) {
    this.stop();
    this.running = true;
    let id = 1e6;
    const steps = demoScript();
    const end = Math.max(...steps.map((s) => s[0]));
    for (const [t, e] of steps) {
      this.timers.push(
        window.setTimeout(() => {
          this.feed({ id: id++, t: Date.now(), kind: 'Unknown', session: '', project: '', ...e } as OfficeEvent);
        }, t * 1000),
      );
    }
    this.timers.push(
      window.setTimeout(() => {
        this.running = false;
        onEnd();
      }, end * 1000 + 500),
    );
  }

  stop() {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.running = false;
  }
}
