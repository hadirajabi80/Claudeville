// The answer card: reply to an agent's question or permission prompt right in the office.
import type { Agent } from './agent';
import type { AskPayload } from './types';
import { hex } from './palette';

export class AnswerCard {
  private el = document.getElementById('answer')!;
  agent: Agent | null = null;
  private ask: AskPayload | null = null;
  private picks: Record<string, Set<string>> = {};
  onAnswered?: (a: Agent) => void;

  constructor() {
    this.el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.close();
    });
    this.el.addEventListener('keyup', (e) => e.stopPropagation());
  }

  get isOpen() {
    return this.el.classList.contains('open');
  }

  open(a: Agent) {
    if (!a.pendingAsk) return;
    this.agent = a;
    this.ask = a.pendingAsk;
    this.picks = {};
    if (document.pointerLockElement) document.exitPointerLock();
    this.render();
    this.el.classList.add('open');
  }

  close() {
    this.el.classList.remove('open');
    this.agent = null;
    this.ask = null;
  }

  /** Close automatically if the question was answered elsewhere. */
  update() {
    if (this.isOpen && (!this.agent || this.agent.pendingAsk?.id !== this.ask?.id)) this.close();
  }

  private async post(body: Record<string, unknown>) {
    const err = this.el.querySelector('.err');
    try {
      const res = await fetch('/api/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-office': '1' },
        body: JSON.stringify({ id: this.ask!.id, ...body }),
      });
      const j = await res.json().catch(() => ({ ok: false }));
      if (!j.ok) throw new Error(j.error || 'Could not send the answer.');
      const a = this.agent;
      this.close();
      if (a && !body.release) this.onAnswered?.(a);
    } catch (e) {
      if (err) err.textContent = (e as Error).message;
    }
  }

  private render() {
    const a = this.agent!;
    const ask = this.ask!;
    const head = `<header><i style="background:${hex(a.rig.accent)}"></i><b>${esc(a.name)}</b>${a.model ? `<span class="mdl">${esc(a.model)}</span>` : ''}<small>${a.role === 'sub' ? 'subagent · ' : ''}${esc(a.subtitle)}</small><button class="x" title="Close (Esc)">✕</button></header>`;
    let body = '';
    if (ask.type === 'permission') {
      body = `<div class="kind">🔐 Asks for permission</div>
        <div class="q" dir="auto">${esc(ask.summary)}</div>
        <div class="btns"><button class="allow">✔ Allow</button><button class="deny">✖ Deny</button></div>
        <input class="why" placeholder="Optional: tell them why not (sent with Deny)" />`;
    } else {
      body = (ask.questions ?? [])
        .map(
          (q, qi) => `<div class="qq" data-q="${qi}">
            ${q.header ? `<div class="kind">${esc(q.header)}</div>` : '<div class="kind">❓ Question</div>'}
            <div class="q" dir="auto">${esc(q.question)}</div>
            <div class="opts">${q.options
              .map((o, oi) => `<button class="opt" data-o="${oi}" dir="auto"><b>${esc(o.label)}</b>${o.description ? `<small>${esc(o.description)}</small>` : ''}</button>`)
              .join('')}</div>
            <input class="other" placeholder="Or type your own answer…" dir="auto" />
            ${q.multiSelect ? '<div class="note">You can pick several.</div>' : ''}
          </div>`,
        )
        .join('');
      body += `<button class="send">Send answer</button>`;
    }
    this.el.innerHTML = `<div class="card">${head}${body}<div class="err"></div><button class="release">Answer in Claude Code instead</button></div>`;
    this.el.querySelector('.x')!.addEventListener('click', () => this.close());
    this.el.querySelector('.release')!.addEventListener('click', () => this.post({ release: true }));
    if (ask.type === 'permission') {
      this.el.querySelector('.allow')!.addEventListener('click', () => this.post({ allow: true }));
      this.el.querySelector('.deny')!.addEventListener('click', () =>
        this.post({ allow: false, message: (this.el.querySelector('.why') as HTMLInputElement).value.trim() || undefined }),
      );
      setTimeout(() => (this.el.querySelector('.allow') as HTMLButtonElement)?.focus(), 30);
      return;
    }
    const qs = ask.questions ?? [];
    this.el.querySelectorAll<HTMLElement>('.qq').forEach((box) => {
      const qi = Number(box.dataset.q);
      const q = qs[qi];
      this.picks[q.question] = new Set();
      box.querySelectorAll<HTMLButtonElement>('.opt').forEach((b) => {
        b.onclick = () => {
          const label = q.options[Number(b.dataset.o)].label;
          const set = this.picks[q.question];
          if (q.multiSelect) {
            if (set.has(label)) set.delete(label);
            else set.add(label);
          } else {
            set.clear();
            set.add(label);
          }
          box.querySelectorAll<HTMLButtonElement>('.opt').forEach((x) => x.classList.toggle('on', set.has(q.options[Number(x.dataset.o)].label)));
          // a single question with a single choice sends right away
          if (qs.length === 1 && !q.multiSelect) this.sendAnswers();
        };
      });
    });
    this.el.querySelector('.send')!.addEventListener('click', () => this.sendAnswers());
    this.el.querySelectorAll<HTMLInputElement>('.other').forEach((inp) =>
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.sendAnswers();
      }),
    );
  }

  private sendAnswers() {
    const qs = this.ask?.questions ?? [];
    const answers: Record<string, string> = {};
    const boxes = [...this.el.querySelectorAll<HTMLElement>('.qq')];
    for (const [i, q] of qs.entries()) {
      const other = (boxes[i]?.querySelector('.other') as HTMLInputElement | null)?.value.trim();
      const picked = [...(this.picks[q.question] ?? [])];
      const value = other || picked.join(', ');
      if (!value) {
        this.el.querySelector('.err')!.textContent = 'Pick an answer for every question.';
        return;
      }
      answers[q.question] = value;
    }
    this.post({ answers });
  }
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
