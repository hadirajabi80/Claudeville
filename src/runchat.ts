// A run's live conversation: what the agent says, the files it reads and edits, the commands it runs and what
// came back, then its final report. Opened from a team task or a dispatched task; polls while the run works.

interface Entry {
  kind: 'say' | 'tool' | 'out' | 'info' | 'error';
  text: string;
  t: number;
}

export class RunChat {
  private el = document.getElementById('runchat')!;
  private runId = '';
  private next = 0;
  private status = '';
  private timer = 0;
  private stick = true;

  constructor() {
    this.el.innerHTML = `
      <header><div class="who"><b class="ttl"></b><small class="sub"></small></div><span class="chip"></span><button class="stop" title="Stop this run">■ Stop</button><button class="x" title="Close (Esc)">✕</button></header>
      <div class="convo" dir="auto"></div>`;
    this.el.querySelector('.x')!.addEventListener('click', () => this.close());
    this.el.querySelector('.stop')!.addEventListener('click', () => this.stopRun());
    const log = this.el.querySelector<HTMLElement>('.convo')!;
    // keep following new lines unless you scrolled up to read
    log.addEventListener('scroll', () => (this.stick = log.scrollTop + log.clientHeight > log.scrollHeight - 30));
    this.el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.close();
    });
  }

  get isOpen() {
    return this.el.classList.contains('open');
  }

  /** Show a run's conversation (from the start), and keep it live while the run works. */
  open(runId: string, title: string, sub = '') {
    this.runId = runId;
    this.next = 0;
    this.status = '';
    this.stick = true;
    this.el.querySelector('.ttl')!.textContent = title;
    this.el.querySelector('.sub')!.textContent = sub;
    this.el.querySelector('.convo')!.innerHTML = '<div class="empty">Waiting for the agent to start…</div>';
    this.el.classList.add('open');
    clearInterval(this.timer);
    this.poll();
    this.timer = window.setInterval(() => this.poll(), 1000);
  }

  close() {
    if (!this.isOpen) return;
    this.el.classList.remove('open');
    clearInterval(this.timer);
  }

  private async poll() {
    const id = this.runId;
    let j: { ok: boolean; status: string; entries: Entry[]; next: number; model?: string };
    try {
      const res = await fetch(`/api/run/log?runId=${encodeURIComponent(id)}&since=${this.next}`, { headers: { 'x-agent-office': '1' } });
      j = await res.json();
    } catch {
      return;
    }
    if (id !== this.runId || !j.ok) return;
    const log = this.el.querySelector<HTMLElement>('.convo')!;
    if (j.entries.length) {
      log.querySelector('.empty')?.remove();
      for (const e of j.entries) log.appendChild(line(e));
      if (this.stick) log.scrollTop = log.scrollHeight;
    }
    this.next = j.next;
    this.status = j.status;
    const chip = this.el.querySelector<HTMLElement>('.chip')!;
    chip.textContent = j.status;
    chip.className = `chip ${j.status}`;
    this.el.querySelector<HTMLElement>('.stop')!.style.display = j.status === 'running' ? '' : 'none';
    if (j.status !== 'running') clearInterval(this.timer); // nothing more will come
  }

  private async stopRun() {
    if (this.status !== 'running') return;
    await fetch('/api/run/stop', { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-office': '1' }, body: JSON.stringify({ runId: this.runId }) });
    this.poll();
  }
}

function line(e: Entry) {
  const d = document.createElement('div');
  d.className = `ln ${e.kind}`;
  d.dir = 'auto';
  const time = new Date(e.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  d.title = time;
  d.textContent = e.text;
  return d;
}

/** A model in a picker, as /api/agents lists it. */
export interface ModelOption {
  id: string;
  label: string;
  ok: boolean;
  note?: string;
}

/**
 * Fill a model <select>: every model the agent can use, plus the ones it can't (greyed out, with the reason).
 * Returns the model that ends up selected (falls back to Default when the wanted one can't run).
 */
export function fillModelSelect(sel: HTMLSelectElement, options: ModelOption[] | undefined, want: string): string {
  const list = options?.length ? options : [{ id: 'default', label: 'Default', ok: true }];
  const usable = list.filter((o) => o.ok);
  const blocked = list.filter((o) => !o.ok);
  const opt = (o: ModelOption) =>
    `<option value="${escAttr(o.id)}"${o.ok ? '' : ' disabled'}>${escAttr(o.label)}${o.note ? ` — ${escAttr(o.note)}` : ''}</option>`;
  sel.innerHTML = usable.map(opt).join('') + (blocked.length ? `<optgroup label="Not available here">${blocked.map(opt).join('')}</optgroup>` : '');
  // a model saved earlier that is not in the list any more stays selectable
  if (want && want !== 'default' && !list.some((o) => o.id === want)) sel.insertAdjacentHTML('beforeend', opt({ id: want, label: want, ok: true, note: 'saved earlier' }));
  const ok = [...sel.options].some((o) => o.value === want && !o.disabled);
  sel.value = ok ? want : 'default';
  return sel.value;
}

function escAttr(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
