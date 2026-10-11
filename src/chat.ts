// Chat with an agent: a side panel plus in-world choreography (listen → think → talk), per the Fable spec.
import * as THREE from 'three';
import type { Agent } from './agent';
import type { Office } from './office';
import type { Player } from './player';
import type { Sound } from './sound';
import type { OfficeEvent } from './types';
import { hex } from './palette';
import { verb } from './office';
import { setMouth } from './character';
import * as R from './reactions';
import { Voice, type VoiceLang } from './voice';

interface Msg {
  from: 'user' | 'agent' | 'error';
  text: string;
}

const CHIPS = ['What are you working on?', 'Why did the last command fail?', 'Summarize what you’ve done so far', 'What’s next?'];

type Phase = 'listen' | 'think' | 'talk';

export class Chat {
  agent: Agent | null = null;
  private history = new Map<string, Msg[]>();
  private recent = new Map<string, string[]>(); // per office agent id: recent activity lines
  private pending: AbortController | null = null;
  private phase: Phase = 'listen';
  private talkUntil = 0;
  private sentences: string[] = [];
  private nextVoice = 0;
  private lastQuestion = '';
  private waitStarted = 0;
  private el = document.getElementById('chat')!;
  private msgs: HTMLElement;
  private input: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private chips: HTMLElement;
  private head: { swatch: HTMLElement; name: HTMLElement; sub: HTMLElement; act: HTMLElement };
  readonly voice = new Voice();
  private micBtn!: HTMLButtonElement;
  private speakBtn!: HTMLButtonElement;
  private langSel!: HTMLSelectElement;
  private speakReplies = true;
  private voiceLang: VoiceLang = 'en-US';
  private pushToTalk = false;
  private warnedNoVoice = false;
  agentIdOf: (officeId: string) => string | undefined = () => undefined;
  onOpenChange?: (open: boolean) => void;

  constructor(
    private office: Office,
    private player: Player,
    private sound: Sound,
    private camera: THREE.Camera,
  ) {
    this.el.innerHTML = `
      <header>
        <i class="sw"></i>
        <div class="who"><b class="nm"></b> <small class="sb"></small><div class="act"></div></div>
        <button class="spk" title="Read replies aloud">🔊</button>
        <button class="x" title="Close (Esc)">✕</button>
      </header>
      <div class="vbar">
        <span>🎤 Speak in</span>
        <select class="vlang"><option value="en-US">English</option><option value="fa-IR">Persian</option></select>
        <span class="vhint">Click the mic, or hold R near an agent</span>
      </div>
      <div class="msgs"></div>
      <div class="chips"></div>
      <div class="inrow">
        <button class="mic" title="Talk (click to start, click again to send)">🎤</button>
        <textarea rows="1" dir="auto" placeholder="Ask something…"></textarea>
        <button class="send" title="Send (Enter)">➤</button>
      </div>`;
    this.msgs = this.el.querySelector('.msgs')!;
    this.input = this.el.querySelector('textarea')!;
    this.sendBtn = this.el.querySelector('.send')!;
    this.chips = this.el.querySelector('.chips')!;
    this.head = {
      swatch: this.el.querySelector('.sw')!,
      name: this.el.querySelector('.nm')!,
      sub: this.el.querySelector('.sb')!,
      act: this.el.querySelector('.act')!,
    };
    this.el.querySelector('.x')!.addEventListener('click', () => this.close());
    this.setupVoice();
    this.sendBtn.addEventListener('click', () => this.send(this.input.value));
    // typing must never move the player or trigger hotkeys
    const stop = (e: KeyboardEvent) => e.stopPropagation();
    this.input.addEventListener('keyup', stop);
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.send(this.input.value);
      } else if (e.key === 'Escape') this.close();
    });
    this.input.addEventListener('input', () => {
      this.input.style.height = 'auto';
      this.input.style.height = Math.min(this.input.scrollHeight, 92) + 'px';
    });
    this.renderChips();
  }

  get isOpen() {
    return !!this.agent;
  }

  // ------------------------------------------------------------------ voice

  private setupVoice() {
    try {
      const v = JSON.parse(localStorage.getItem('office-voice') ?? '{}');
      if (v.lang === 'fa-IR' || v.lang === 'en-US') this.voiceLang = v.lang;
      if (typeof v.speak === 'boolean') this.speakReplies = v.speak;
    } catch {
      /* ignore */
    }
    this.micBtn = this.el.querySelector('.mic')!;
    this.speakBtn = this.el.querySelector('.spk')!;
    this.langSel = this.el.querySelector('.vlang')!;
    this.langSel.value = this.voiceLang;
    const save = () => {
      try {
        localStorage.setItem('office-voice', JSON.stringify({ lang: this.voiceLang, speak: this.speakReplies }));
      } catch {
        /* ignore */
      }
    };
    this.langSel.onchange = () => {
      this.voiceLang = this.langSel.value as VoiceLang;
      save();
    };
    this.langSel.addEventListener('keydown', (e) => e.stopPropagation());
    const syncSpeak = () => {
      this.speakBtn.classList.toggle('off', !this.speakReplies);
      this.speakBtn.title = this.speakReplies ? 'Reading replies aloud (click to turn off)' : 'Replies are silent (click to read them aloud)';
    };
    syncSpeak();
    this.speakBtn.onclick = () => {
      this.speakReplies = !this.speakReplies;
      if (!this.speakReplies) this.voice.stopSpeaking();
      syncSpeak();
      save();
    };
    if (!this.voice.canSpeak) this.speakBtn.style.display = 'none';
    if (!this.voice.canListen) {
      this.micBtn.disabled = true;
      this.micBtn.title = 'Voice input needs Chrome or Edge';
      (this.el.querySelector('.vbar') as HTMLElement).style.display = 'none';
    }
    this.micBtn.onclick = () => (this.voice.isListening ? this.stopVoice(true) : this.startVoice());
    this.voice.onListenChange = (on) => {
      this.micBtn.classList.toggle('live', on);
      this.input.placeholder = on ? 'Listening… (click 🎤 again to send)' : 'Ask something…';
      if (on && this.agent) {
        this.office.emote(this.agent, 'question', 1.2);
        this.sound.duckFor(1.5);
      }
    };
    this.voice.onTranscript = (text) => {
      this.input.value = text;
      this.input.dispatchEvent(new Event('input'));
    };
    this.voice.onSend = (text) => this.send(text);
    this.voice.onError = (msg) => this.toast(msg);
  }

  /** Start listening to the microphone (the chat must be open). */
  startVoice(ptt = false) {
    if (!this.agent || !this.voice.canListen || this.pending) return;
    this.pushToTalk = ptt;
    this.input.value = '';
    this.voice.listen(this.voiceLang);
  }

  stopVoice(send: boolean) {
    this.pushToTalk = false;
    this.voice.stop(send);
  }

  get isPushToTalk() {
    return this.pushToTalk;
  }

  private toast(msg: string) {
    const t = document.createElement('div');
    t.className = 'hint';
    t.textContent = msg;
    this.msgs.appendChild(t);
    this.msgs.scrollTop = this.msgs.scrollHeight;
  }

  /** Remember what each agent has been doing (also covers demo agents the server never saw). */
  track(e: OfficeEvent, officeId: string | null) {
    if (!officeId) return;
    const list = this.recent.get(officeId) ?? [];
    list.push(`${new Date(e.t).toLocaleTimeString()} ${e.kind}${e.tool ? ' ' + e.tool : ''}${e.detail ? ' — ' + e.detail : ''}`);
    if (list.length > 30) list.shift();
    this.recent.set(officeId, list);
  }

  open(a: Agent, focus = true) {
    if (a.role === 'player' || a.removed) return;
    if (this.agent === a) {
      this.input.focus();
      return;
    }
    this.close(true);
    this.agent = a;
    this.player.releaseKeys();
    if (document.pointerLockElement) document.exitPointerLock();
    this.el.classList.add('open');
    document.body.classList.add('chat');
    this.renderHeader();
    this.renderMessages();
    this.setPhase('listen');
    this.office.emote(a, 'exclaim', 1);
    a.say(pick(['Yes?', 'Hi! What’s up?', 'Hm?', 'Yes, boss?']), 'say', 1.6);
    this.player.listenTarget = a.position;
    if (focus) setTimeout(() => this.input.focus(), 30);
    this.onOpenChange?.(true);
  }

  close(silent = false) {
    const a = this.agent;
    if (!a) return;
    this.pending?.abort();
    this.pending = null;
    this.voice.cancel();
    this.voice.stopSpeaking();
    a.muteBabble = false;
    if (a.reaction?.name.startsWith('chat-')) a.endReaction();
    this.agent = null;
    this.player.listenTarget = null;
    this.el.classList.remove('open');
    document.body.classList.remove('chat');
    this.input.blur();
    if (!silent) this.onOpenChange?.(false);
  }

  private who = () => {
    if (this.player.spawned && this.player.mode !== 'orbit') return this.player.agent.headWorld(new THREE.Vector3());
    return this.camera.position;
  };

  private setPhase(p: Phase, talkDur = 3) {
    const a = this.agent;
    if (!a) return;
    this.phase = p;
    if (a.reaction?.name.startsWith('chat-')) a.endReaction();
    if (p === 'listen') a.react(R.chatListen(a, this.who));
    else if (p === 'think') a.react(R.chatThink(a, this.who));
    else {
      this.talkUntil = performance.now() + talkDur * 1000;
      a.react({ ...R.chatTalk(a, this.who, talkDur, (o) => setMouth(a.rig, o)), onDone: () => this.agent === a && this.setPhase('listen') });
    }
  }

  private async send(text: string) {
    const a = this.agent;
    const q = text.trim();
    if (!a || !q || this.pending) return;
    this.input.value = '';
    this.input.style.height = 'auto';
    this.lastQuestion = q;
    this.push(a, { from: 'user', text: q });
    this.setPhase('think');
    this.office.emote(a, 'question', 1.4);
    a.say('…', 'think', 60);
    this.waitStarted = performance.now();
    this.renderMessages(true);
    const ctrl = new AbortController();
    this.pending = ctrl;
    this.sendBtn.disabled = true;
    const timeout = setTimeout(() => ctrl.abort(), 125_000);
    try {
      const hist = (this.history.get(a.id) ?? []).filter((m) => m.from !== 'error').slice(-9, -1);
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-office': '1' },
        signal: ctrl.signal,
        body: JSON.stringify({
          session: a.session,
          agentId: this.agentIdOf(a.id),
          name: a.name,
          role: a.role,
          subtitle: a.subtitle,
          activity: a.activity ? verb(a.activity) : a.busyWorking ? 'working' : 'on a break',
          recent: this.recent.get(a.id) ?? [],
          question: q,
          history: hist.map((m) => ({ from: m.from, text: m.text })),
        }),
      });
      const j = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
      if (this.pending !== ctrl) return;
      if (!j.ok) throw new Error(j.error || 'no answer');
      this.answer(a, String(j.answer));
    } catch (err) {
      if (this.pending !== ctrl) return;
      const msg = (err as Error).name === 'AbortError' ? 'timed out' : (err as Error).message;
      this.push(a, { from: 'error', text: msg });
      if (a.bubble?.tone === 'think') a.bubble.until = performance.now();
      this.setPhase('listen');
      a.say('Sorry, I couldn’t answer that… 😅', 'say', 2);
    } finally {
      clearTimeout(timeout);
      if (this.pending === ctrl) this.pending = null;
      this.sendBtn.disabled = false;
      if (this.agent === a) this.renderMessages();
    }
  }

  private answer(a: Agent, text: string) {
    this.push(a, { from: 'agent', text });
    if (this.agent !== a) return;
    if (this.speakReplies && this.voice.canSpeak) {
      this.speakAnswer(a, text);
      return;
    }
    const dur = Math.max(2, Math.min(8, 1.5 + text.length / 40));
    if (a.bubble?.tone === 'think') a.bubble.until = performance.now();
    this.setPhase('talk', dur);
    const short = text.replace(/\s+/g, ' ');
    a.say(short.length > 60 ? short.slice(0, 59) + '…' : short, 'say', dur + 1);
    this.sentences = short.split(/(?<=[.!?\u061F])\s+/).slice(1, 8);
    this.nextVoice = performance.now() + 1100;
    this.player.nod();
  }

  /** Real voice: the agent talks (mouth, gestures) for as long as the speech lasts. */
  private async speakAnswer(a: Agent, text: string) {
    const est = Math.max(2.5, Math.min(60, text.length / 13));
    if (a.bubble?.tone === 'think') a.bubble.until = performance.now();
    a.muteBabble = true;
    const short = text.replace(/\s+/g, ' ');
    a.say(short.length > 60 ? short.slice(0, 59) + '…' : short, 'say', est + 1);
    this.setPhase('talk', est + 2);
    this.sound.duckFor(est + 0.5);
    this.player.nod();
    const ok = await this.voice.speak(text, { gender: a.rig.gender, pitch: a.role === 'sub' ? 1.15 : a.rig.gender === 'f' ? 1.1 : 0.95 });
    a.muteBabble = false;
    if (!ok) {
      if (!this.warnedNoVoice) {
        this.warnedNoVoice = true;
        this.toast(/[\u0600-\u06FF]/.test(text) ? 'This browser has no Persian voice installed, so the reply is shown as text. Edge has Persian voices.' : 'No speech voice is available in this browser.');
      }
      this.sentences = short.split(/(?<=[.!?\u061F])\s+/).slice(0, 8);
      this.nextVoice = performance.now();
      this.talkUntil = performance.now() + Math.min(8, est) * 1000;
      return;
    }
    if (this.agent === a && a.reaction?.name === 'chat-talk') this.setPhase('listen');
  }

  private push(a: Agent, m: Msg) {
    const list = this.history.get(a.id) ?? [];
    list.push(m);
    if (list.length > 40) list.shift();
    this.history.set(a.id, list);
  }

  // ------------------------------------------------------------------ rendering

  private renderHeader() {
    const a = this.agent;
    if (!a) return;
    this.head.swatch.style.background = hex(a.rig.accent);
    this.head.name.textContent = (a.role === 'sub' ? `↳ ${a.name}` : a.name) + (a.model ? ` · ${a.model}` : '');
    this.head.sub.textContent = a.subtitle;
    const state = a.removed ? 'left the office' : a.activity && a.busyWorking ? verb(a.activity) : a.busyWorking ? 'working' : a.walking ? 'walking' : 'on a break';
    this.head.act.textContent = state;
  }

  private renderMessages(waiting = false) {
    const a = this.agent;
    if (!a) return;
    const list = this.history.get(a.id) ?? [];
    this.msgs.innerHTML = '';
    if (!list.length) {
      const hello = document.createElement('div');
      hello.className = 'hint';
      hello.textContent = `Ask ${a.name} anything. Answers come from their real work in Claude Code.`;
      this.msgs.appendChild(hello);
    }
    list.forEach((m, i) => {
      const b = document.createElement('div');
      b.className = `msg ${m.from}`;
      b.dir = 'auto';
      if (m.from === 'agent') b.style.setProperty('--accent', hex(a.rig.accent));
      if (m.from === 'error') {
        b.textContent = `Couldn’t reach ${a.name}: ` + m.text + ' ';
        if (i === list.length - 1) {
          const retry = document.createElement('button');
          retry.textContent = 'Retry';
          retry.onclick = () => {
            list.pop();
            const lastUser = [...list].reverse().find((x) => x.from === 'user');
            if (lastUser) list.splice(list.lastIndexOf(lastUser), 1);
            this.send(this.lastQuestion);
          };
          b.appendChild(retry);
        }
      } else b.textContent = m.text;
      this.msgs.appendChild(b);
    });
    if (waiting || this.pending) {
      const t = document.createElement('div');
      t.className = 'msg agent typing';
      t.innerHTML = '<span></span><span></span><span></span><em></em>';
      this.msgs.appendChild(t);
    }
    this.chips.style.display = this.pending ? 'none' : '';
    this.msgs.scrollTop = this.msgs.scrollHeight;
  }

  private renderChips() {
    this.chips.innerHTML = '';
    for (const c of CHIPS) {
      const b = document.createElement('button');
      b.textContent = c;
      b.onclick = () => this.send(c);
      this.chips.appendChild(b);
    }
  }

  // ------------------------------------------------------------------ per frame

  update() {
    const a = this.agent;
    if (!a) return;
    if (a.removed) {
      this.renderHeader();
      this.input.disabled = true;
      return;
    }
    this.input.disabled = false;
    // a tease (or a live event) may have replaced our overlay: put it back
    if (!a.reaction && !a.held && !a.falling) this.setPhase(this.phase === 'talk' && performance.now() < this.talkUntil ? 'listen' : this.phase === 'think' ? 'think' : 'listen');
    const now = performance.now();
    if (this.phase === 'talk' && this.sentences.length && now > this.nextVoice && now < this.talkUntil) {
      this.nextVoice = now + 1100;
      this.sound.voice(this.sentences.shift()!, a.voicePitch, a.headWorld(new THREE.Vector3()));
    }
    // waiting captions
    const typing = this.msgs.querySelector('.typing em');
    if (typing && this.pending) {
      const s = (now - this.waitStarted) / 1000;
      typing.textContent = s > 15 ? 'still working on it…' : s > 6 ? 'thinking…' : '';
    }
  }

  /** Refresh the header (called on the HUD's slow tick). */
  refresh() {
    if (this.agent) this.renderHeader();
  }
}

function pick<T>(a: T[]) {
  return a[Math.floor(Math.random() * a.length)];
}
