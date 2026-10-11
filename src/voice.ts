// Voice chat: speech-to-text for your questions, text-to-speech for agents' answers.
// Uses the browser's built-in Web Speech API (best in Chrome and Edge).

type Rec = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
};

const FEMALE_HINT = /female|woman|zira|aria|jenny|emma|ava|sonia|libby|michelle|samantha|victoria|karen|moira|tessa|dilara|hazel|susan|linda|heera|google uk english female|google us english/i;
const MALE_HINT = /male|man|david|mark|guy|ryan|christopher|eric|roger|steffan|thomas|alex|daniel|fred|farid|george|james|google uk english male/i;

export type VoiceLang = 'en-US' | 'fa-IR';

export class Voice {
  readonly canListen: boolean;
  readonly canSpeak: boolean;
  private rec: Rec | null = null;
  private listening = false;
  private finalText = '';
  private interim = '';
  private sendOnEnd = false;
  onTranscript?: (text: string, final: boolean) => void;
  onListenChange?: (on: boolean) => void;
  onError?: (msg: string) => void;
  onSend?: (text: string) => void;

  constructor() {
    const C = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    this.canListen = !!C;
    this.canSpeak = 'speechSynthesis' in window;
    if (C) {
      const r: Rec = new C();
      r.interimResults = true;
      r.continuous = true;
      r.maxAlternatives = 1;
      r.onresult = (e: any) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i];
          if (res.isFinal) this.finalText += res[0].transcript;
          else interim += res[0].transcript;
        }
        this.interim = interim;
        this.onTranscript?.((this.finalText + ' ' + interim).trim(), false);
      };
      r.onerror = (e: any) => {
        const code = String(e.error || 'error');
        if (code === 'no-speech' || code === 'aborted') return;
        this.onError?.(
          code === 'not-allowed' || code === 'service-not-allowed'
            ? 'Microphone access was blocked. Allow it in the browser’s address bar.'
            : code === 'network'
              ? 'Speech recognition needs an internet connection.'
              : `Speech recognition error: ${code}`,
        );
      };
      r.onend = () => {
        this.listening = false;
        this.onListenChange?.(false);
        const text = (this.finalText + ' ' + this.interim).trim();
        this.onTranscript?.(text, true);
        if (this.sendOnEnd && text) this.onSend?.(text);
        this.sendOnEnd = false;
      };
      r.onstart = () => {
        this.listening = true;
        this.onListenChange?.(true);
      };
      this.rec = r;
    }
    // voices load asynchronously in Chrome
    if (this.canSpeak) speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices();
  }

  get isListening() {
    return this.listening;
  }

  /** Start listening. When stopped with send=true (or on a natural pause, if autoSend), the text is sent. */
  listen(lang: VoiceLang) {
    if (!this.rec || this.listening) return;
    this.stopSpeaking();
    this.finalText = '';
    this.interim = '';
    this.sendOnEnd = false;
    this.rec.lang = lang;
    try {
      this.rec.start();
    } catch {
      /* already started */
    }
  }

  stop(send: boolean) {
    if (!this.rec || !this.listening) return;
    this.sendOnEnd = send;
    this.rec.stop();
  }

  cancel() {
    if (!this.rec) return;
    this.sendOnEnd = false;
    this.rec.abort();
  }

  // ------------------------------------------------------------------ speaking

  private pickVoice(text: string, gender: 'm' | 'f'): SpeechSynthesisVoice | null {
    const voices = speechSynthesis.getVoices();
    if (!voices.length) return null;
    const persian = /[؀-ۿ]/.test(text);
    const want = persian ? /^fa/i : /^en/i;
    const lang = voices.filter((v) => want.test(v.lang));
    if (!lang.length) return persian ? null : voices[0];
    const hint = gender === 'f' ? FEMALE_HINT : MALE_HINT;
    const other = gender === 'f' ? MALE_HINT : FEMALE_HINT;
    // prefer natural/online voices, then a gender match
    const score = (v: SpeechSynthesisVoice) =>
      (/natural|online|neural/i.test(v.name) ? 4 : 0) + (hint.test(v.name) && !(gender === 'f' && /\bmale\b/i.test(v.name) && !/female/i.test(v.name)) ? 2 : 0) - (other.test(v.name) && !hint.test(v.name) ? 3 : 0) + (/en-US/i.test(v.lang) ? 1 : 0);
    return [...lang].sort((a, b) => score(b) - score(a))[0];
  }

  /** Read text aloud. Resolves when finished; returns false if no suitable voice exists (e.g. no Persian voice). */
  speak(text: string, opts: { gender: 'm' | 'f'; pitch: number; onStart?: () => void }): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.canSpeak) return resolve(false);
      const voice = this.pickVoice(text, opts.gender);
      if (!voice) return resolve(false);
      speechSynthesis.cancel();
      const clean = text.replace(/```[\s\S]*?```/g, ' code block ').replace(/[`*_#>]/g, '').replace(/https?:\/\/\S+/g, 'a link');
      const u = new SpeechSynthesisUtterance(clean);
      u.voice = voice;
      u.lang = voice.lang;
      u.rate = 1.05;
      u.pitch = Math.max(0.6, Math.min(1.6, opts.pitch));
      u.onstart = () => opts.onStart?.();
      u.onend = () => resolve(true);
      u.onerror = () => resolve(true);
      speechSynthesis.speak(u);
    });
  }

  stopSpeaking() {
    if (this.canSpeak) speechSynthesis.cancel();
  }

  get speaking() {
    return this.canSpeak && speechSynthesis.speaking;
  }
}
