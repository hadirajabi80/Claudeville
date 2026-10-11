// Turns the Claude Code hook event stream into character commands on the Stage.
import { toolKind, type OfficeEvent, type Stage } from './types';

interface LeadInfo {
  id: string;
  session: string;
  working: boolean;
  last: number;
  run?: string; // dispatched from the manager desk
}

interface SubInfo {
  id: string;
  session: string;
  agentId?: string; // bound once SubagentStart (or a tool event carrying agent_id) arrives
  toolUseId?: string;
  bound: boolean;
  last: number;
  launchDoneAt?: number; // PostToolUse(Agent) seen for an unbound sub
  model?: string;
}

const LEAD_IDLE_MS = 5 * 60_000;
const SUB_IDLE_MS = 15 * 60_000;
const UNBOUND_GRACE_MS = 20_000;

const SUB_NAMES: Record<string, string> = {
  Explore: 'Scout',
  Plan: 'Architect',
  'general-purpose': 'Helper',
  'claude-code-guide': 'Guide',
  'statusline-setup': 'Stylist',
};

let subCounter = 0;

export class Director {
  private leads = new Map<string, LeadInfo>(); // by session
  private subs = new Map<string, SubInfo>(); // by character id
  private instant = false;
  onChange?: () => void;

  constructor(private stage: Stage) {}

  /** Rebuild state from recent history without playing every animation. */
  replay(events: OfficeEvent[]) {
    this.instant = true;
    for (const e of events) this.handle(e);
    this.instant = false;
    this.onChange?.();
  }

  handle(e: OfficeEvent) {
    const now = e.t || Date.now();
    this.applyModel(e);
    switch (e.kind) {
      case 'SessionStart':
        this.ensureLead(e, now);
        break;
      case 'UserPromptSubmit': {
        const lead = this.ensureLead(e, now);
        this.setWorking(lead, true);
        this.stage.activity(lead.id, { kind: 'think', detail: e.detail || 'thinking…' });
        break;
      }
      case 'PreToolUse': {
        const id = this.targetFor(e, now);
        if (!e.agentId) {
          const lead = this.leads.get(e.session)!;
          this.setWorking(lead, true);
          if (e.tool === 'Agent' || e.tool === 'Task') this.launchSub(e, now);
        }
        this.stage.activity(id, { kind: toolKind(e.tool), tool: e.tool, detail: e.detail });
        break;
      }
      case 'PostToolUse':
      case 'PostToolUseFailure': {
        const id = this.targetFor(e, now);
        this.stage.toolDone(id, e.kind === 'PostToolUseFailure');
        if (!e.agentId && (e.tool === 'Agent' || e.tool === 'Task')) {
          const sub = [...this.subs.values()].find((s) => s.toolUseId && s.toolUseId === e.toolUseId);
          if (sub && !sub.bound) sub.launchDoneAt = now;
        }
        break;
      }
      case 'SubagentStart':
        this.bindSub(e, now);
        break;
      case 'SubagentStop': {
        const sub = this.findSub(e);
        if (sub) this.finishSub(sub, true);
        break;
      }
      case 'Ask': {
        if (!e.ask?.summary) break;
        const id = this.targetFor(e, now);
        this.stage.ask(id, e.ask); // also on replay: AskDone (if any) clears it again
        break;
      }
      case 'AskDone':
        if (e.ask?.id) this.stage.clearAsk(e.ask.id, e.ask.how ?? '');
        break;
      case 'RunDone': {
        const charId = e.runId ? this.runChars.get(e.runId) : undefined;
        if (!charId) break;
        this.runChars.delete(e.runId!);
        for (const [sid, l] of this.leads) if (l.id === charId) this.leads.delete(sid);
        if (!this.instant) this.stage.report(charId, !!e.ok, e.detail ?? '');
        else this.stage.leave(charId, false, true);
        break;
      }
      case 'Stop':
      case 'StopFailure': {
        const lead = this.leads.get(e.session);
        if (lead?.run) break; // a dispatched task reports back when its run ends
        if (lead && lead.working) {
          lead.working = false;
          lead.last = now;
          this.stage.idle(lead.id, e.kind === 'Stop' ? 'happy' : 'sad', this.instant);
        }
        break;
      }
      case 'Notification': {
        const lead = this.ensureLead(e, now);
        if (!this.instant) this.stage.notify(lead.id, e.detail || 'Needs your attention');
        break;
      }
      case 'SessionEnd': {
        const lead = this.leads.get(e.session);
        for (const s of [...this.subs.values()]) if (s.session === e.session) this.finishSub(s, false);
        if (lead?.run) break;
        if (lead) {
          this.stage.leave(lead.id, false, this.instant);
          this.leads.delete(e.session);
        }
        break;
      }
    }
    if (!this.instant) this.onChange?.();
  }

  private leadModel = new Map<string, string>();
  private runChars = new Map<string, string>(); // runId -> character id

  /** The manager called a character for a task; its run's events will drive that character. */
  expectRun(runId: string, charId: string) {
    this.runChars.set(runId, charId);
  }

  /** Keep each character's model label current; subagents inherit the lead's model until known. */
  private applyModel(e: OfficeEvent) {
    if (e.model && !e.agentId) {
      this.leadModel.set(e.session, e.model);
      const lead = this.leads.get(e.session);
      if (lead) this.stage.setModel(lead.id, e.model);
    }
    if (e.model && e.agentId) {
      const sub = [...this.subs.values()].find((s) => s.agentId === e.agentId);
      if (sub) {
        sub.model = e.model;
        this.stage.setModel(sub.id, e.model);
      }
    }
  }

  /** Called every second: cleans up stale characters when hooks were missed. */
  tick(now = Date.now()) {
    for (const lead of this.leads.values()) {
      if (lead.working && now - lead.last > LEAD_IDLE_MS) {
        lead.working = false;
        this.stage.idle(lead.id, 'happy', false);
      }
    }
    for (const sub of [...this.subs.values()]) {
      const unboundDone = sub.launchDoneAt && !sub.bound && now - sub.launchDoneAt > UNBOUND_GRACE_MS && sub.last <= sub.launchDoneAt;
      if (unboundDone || now - sub.last > SUB_IDLE_MS) this.finishSub(sub, true);
    }
  }

  /** Claude Code agent_id behind a subagent character (for chat context). */
  agentIdOf(officeId: string): string | undefined {
    return this.subs.get(officeId)?.agentId;
  }

  /** Which character an event belongs to, without changing any state. */
  officeIdFor(e: OfficeEvent): string | null {
    if (!e.agentId) return this.leads.has(e.session) ? `lead:${e.session}` : null;
    for (const s of this.subs.values()) if (s.agentId === e.agentId) return s.id;
    return null;
  }

  stats() {
    return {
      sessions: this.leads.size,
      working: [...this.leads.values()].filter((l) => l.working).length,
      subagents: this.subs.size,
    };
  }

  // ---------------------------------------------------------------------------

  private ensureLead(e: OfficeEvent, now: number): LeadInfo {
    let lead = this.leads.get(e.session);
    if (!lead && e.runId && this.runChars.has(e.runId)) {
      // first event of a dispatched task: bind its session to the character that was called
      lead = { id: this.runChars.get(e.runId)!, session: e.session, working: false, last: now, run: e.runId };
      this.leads.set(e.session, lead);
    }
    if (!lead) {
      lead = { id: `lead:${e.session}`, session: e.session, working: false, last: now };
      this.leads.set(e.session, lead);
      if (!this.stage.has(lead.id)) {
        this.stage.spawn(lead.id, {
          role: 'lead',
          name: 'Claude',
          subtitle: e.project || e.session.slice(0, 8),
          session: e.session,
          instant: this.instant,
        });
      }
      const m = e.model ?? this.leadModel.get(e.session);
      if (m && !e.agentId) this.stage.setModel(lead.id, m);
    }
    lead.last = now;
    return lead;
  }

  private setWorking(lead: LeadInfo, on: boolean) {
    if (lead.working === on) return;
    lead.working = on;
    if (on) this.stage.work(lead.id, this.instant);
  }

  /** Character id that a tool event belongs to (lead or subagent). */
  private targetFor(e: OfficeEvent, now: number): string {
    const lead = this.ensureLead(e, now);
    if (!e.agentId) return lead.id;
    let sub = this.findSub(e);
    if (!sub) sub = this.bindSub(e, now);
    sub.last = now;
    return sub.id;
  }

  private launchSub(e: OfficeEvent, now: number) {
    const id = `sub:${++subCounter}`;
    this.subs.set(id, { id, session: e.session, toolUseId: e.toolUseId, bound: false, last: now, model: e.subModel ?? this.leadModel.get(e.session) });
    this.stage.spawn(id, {
      role: 'sub',
      name: 'Agent',
      subtitle: e.detail || 'subagent',
      session: e.session,
      instant: this.instant,
    });
    this.stage.work(id, this.instant);
    const sm = this.subs.get(id)!.model;
    if (sm) this.stage.setModel(id, sm);
  }

  private bindSub(e: OfficeEvent, now: number): SubInfo {
    const existing = this.findSub(e);
    if (existing) return existing;
    // Pair with the oldest unbound launch from the same session, else create one.
    let sub = [...this.subs.values()].find((s) => s.session === e.session && !s.bound);
    if (!sub) {
      this.ensureLead(e, now);
      const id = `sub:${++subCounter}`;
      sub = { id, session: e.session, bound: false, last: now };
      this.subs.set(id, sub);
      this.stage.spawn(id, {
        role: 'sub',
        name: 'Agent',
        subtitle: e.agentType || 'subagent',
        session: e.session,
        instant: this.instant,
      });
      this.stage.work(id, this.instant);
    }
    sub.bound = true;
    sub.agentId = e.agentId;
    sub.last = now;
    if (e.agentType) this.stage.rename(sub.id, SUB_NAMES[e.agentType] ?? cap(e.agentType), e.agentType);
    return sub;
  }

  private findSub(e: OfficeEvent): SubInfo | undefined {
    const all = [...this.subs.values()];
    if (e.agentId) return all.find((s) => s.agentId === e.agentId);
    if (e.kind === 'SubagentStop') return all.find((s) => s.session === e.session);
    return undefined;
  }

  private finishSub(sub: SubInfo, celebrate: boolean) {
    this.subs.delete(sub.id);
    this.stage.leave(sub.id, celebrate, this.instant);
  }
}

function cap(s: string) {
  const w = s.replace(/[-_]/g, ' ');
  return w.charAt(0).toUpperCase() + w.slice(1);
}
