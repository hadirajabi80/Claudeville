// Synthesized audio: 3D positional effects, character voices, ambience and generative lo-fi music.
// Everything is made with WebAudio oscillators and noise, no sound files.
import * as THREE from 'three';

type At = THREE.Vector3 | undefined;

const fwd = new THREE.Vector3();
const up = new THREE.Vector3();

export class Sound {
  enabled = true; // user preference; audio starts on the first click / key press (autoplay rules)
  musicOn = true;
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private music!: GainNode;
  private amb!: GainNode;
  private noiseBuf!: AudioBuffer;
  /** Tiny, frequent sounds (keys, footsteps) use cheap equal-power panning instead of HRTF. */
  private panModel: PanningModelType = 'HRTF';
  private live = 0;
  private brownBuf!: AudioBuffer;
  private musicTimer = 0;
  private nextBar = 0;
  private bar = 0;
  onStateChange?: () => void;

  constructor() {
    try {
      const saved = JSON.parse(localStorage.getItem('office-sound') ?? 'null');
      if (saved) {
        this.enabled = !!saved.enabled;
        this.musicOn = !!saved.music;
      }
    } catch {
      /* storage unavailable */
    }
    const unlock = () => {
      if (this.enabled) this.start();
    };
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      this.master.gain.setTargetAtTime(document.hidden ? 0 : 0.8, this.ctx.currentTime, 0.1);
    });
    addEventListener('pointerdown', unlock, { capture: true });
    addEventListener('keydown', unlock, { capture: true });
  }

  get running() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  private save() {
    try {
      localStorage.setItem('office-sound', JSON.stringify({ enabled: this.enabled, music: this.musicOn }));
    } catch {
      /* ignore */
    }
  }

  private start() {
    if (!this.ctx) {
      const c = new AudioContext();
      this.ctx = c;
      this.master = c.createGain();
      this.master.gain.value = 0.8;
      // gentle bus compressor keeps bursts (confetti chimes, many typists) from clipping
      const comp = c.createDynamicsCompressor();
      comp.threshold.value = -16;
      comp.ratio.value = 4;
      this.master.connect(comp).connect(c.destination);
      this.sfx = c.createGain();
      this.sfx.gain.value = 1;
      this.sfx.connect(this.master);
      this.music = c.createGain();
      this.music.gain.value = this.musicOn ? 0.3 : 0;
      this.music.connect(this.master);
      this.amb = c.createGain();
      this.amb.gain.value = 0.5;
      this.amb.connect(this.master);
      this.noiseBuf = this.makeNoise(false);
      this.brownBuf = this.makeNoise(true);
      this.startAmbience();
      this.nextBar = c.currentTime + 0.3;
    }
    if (this.ctx.state !== 'running') this.ctx.resume();
    this.onStateChange?.();
  }

  toggle() {
    this.enabled = !this.enabled;
    if (this.enabled) this.start();
    else this.ctx?.suspend();
    this.save();
    this.onStateChange?.();
    return this.enabled;
  }

  toggleMusic() {
    this.musicOn = !this.musicOn;
    if (this.ctx) this.music.gain.setTargetAtTime(this.musicOn ? this.musicBase : 0, this.ctx.currentTime, 0.4);
    this.save();
    this.onStateChange?.();
    return this.musicOn;
  }

  /** Move the ear to the active camera every frame. */
  setListener(cam: THREE.Camera) {
    if (!this.running) return;
    const l = this.ctx!.listener;
    const t = this.ctx!.currentTime;
    cam.getWorldDirection(fwd);
    up.set(0, 1, 0).applyQuaternion(cam.quaternion);
    if (l.positionX) {
      l.positionX.setTargetAtTime(cam.position.x, t, 0.02);
      l.positionY.setTargetAtTime(cam.position.y, t, 0.02);
      l.positionZ.setTargetAtTime(cam.position.z, t, 0.02);
      l.forwardX.setTargetAtTime(fwd.x, t, 0.02);
      l.forwardY.setTargetAtTime(fwd.y, t, 0.02);
      l.forwardZ.setTargetAtTime(fwd.z, t, 0.02);
      l.upX.setTargetAtTime(up.x, t, 0.02);
      l.upY.setTargetAtTime(up.y, t, 0.02);
      l.upZ.setTargetAtTime(up.z, t, 0.02);
    } else {
      l.setPosition(cam.position.x, cam.position.y, cam.position.z);
      l.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
  }

  /** Call every frame: schedules the generative music. */
  update() {
    if (!this.running) return;
    const c = this.ctx!;
    while (this.nextBar < c.currentTime + 0.5) {
      this.scheduleBar(this.nextBar);
      this.nextBar += BAR;
      this.bar++;
    }
    this.musicTimer++;
  }

  // ------------------------------------------------------------------ plumbing

  private makeNoise(brown: boolean) {
    const c = this.ctx!;
    const len = c.sampleRate * 2;
    const b = c.createBuffer(1, len, c.sampleRate);
    const d = b.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (brown) {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      } else d[i] = w;
    }
    return b;
  }

  /** Destination node for a sound: a 3D panner when it has a position, else the plain sfx bus. */
  private out(at: At, vol = 1, bus?: GainNode): AudioNode {
    const c = this.ctx!;
    const g = c.createGain();
    g.gain.value = vol;
    if (at) {
      const p = c.createPanner();
      p.panningModel = this.panModel;
      p.distanceModel = 'inverse';
      p.refDistance = 1.6;
      p.rolloffFactor = 1.3;
      p.maxDistance = 40;
      p.positionX.value = at.x;
      p.positionY.value = at.y;
      p.positionZ.value = at.z;
      g.connect(p).connect(bus ?? this.sfx);
    } else g.connect(bus ?? this.sfx);
    return g;
  }

  private tone(freq: number, dur: number, type: OscillatorType, vol: number, slide = 1, delay = 0, at?: At, attack = 0.004) {
    if (!this.running) return;
    const c = this.ctx!;
    const t = c.currentTime + delay;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide !== 1) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.out(at));
    o.start(t);
    o.stop(t + dur + 0.05);
    this.live++;
    o.onended = () => this.live--;
  }

  private noise(dur: number, freq: number, vol: number, q = 1, type: BiquadFilterType = 'bandpass', slide = 1, delay = 0, at?: At, brown = false) {
    if (!this.running) return;
    const c = this.ctx!;
    const t = c.currentTime + delay;
    const src = c.createBufferSource();
    src.buffer = brown ? this.brownBuf : this.noiseBuf;
    const f = c.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(freq, t);
    if (slide !== 1) f.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.out(at));
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.05);
    this.live++;
    src.onended = () => this.live--;
  }

  private startAmbience() {
    const c = this.ctx!;
    // soft room tone: brown noise through a low shelf, barely audible
    const src = c.createBufferSource();
    src.buffer = this.brownBuf;
    src.loop = true;
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 320;
    const g = c.createGain();
    g.gain.value = 0.05;
    src.connect(f).connect(g).connect(this.amb);
    src.start();
    // faint HVAC hum
    const hum = c.createOscillator();
    hum.frequency.value = 60;
    const hg = c.createGain();
    hg.gain.value = 0.006;
    hum.connect(hg).connect(this.amb);
    hum.start();
  }

  // ------------------------------------------------------------------ office sounds (optionally positional)

  private cheap(fn: () => void) {
    if (this.live > 48) return; // too many sounds at once: skip the tiny ones
    this.panModel = 'equalpower';
    fn();
    this.panModel = 'HRTF';
  }

  key(at?: At) {
    this.cheap(() => this.keyRaw(at));
  }

  private keyRaw(at?: At) {
    this.noise(0.022, 2200 + Math.random() * 1800, 0.22, 2.5, 'bandpass', 1, 0, at);
    if (Math.random() < 0.08) this.noise(0.04, 900, 0.18, 1.5, 'bandpass', 1, 0, at); // space bar
  }

  step(at?: At, rug = false, heavy = 1, player = false) {
    this.cheap(() => this.stepRaw(at, rug, heavy, player));
  }

  private stepRaw(at?: At, rug = false, heavy = 1, player = false) {
    const v = (player ? 0.18 : 0.08) * heavy * (rug ? 0.6 : 1);
    const pitch = 1 + (Math.random() - 0.5) * 0.16;
    if (rug) {
      this.noise(0.04, 500 * pitch, v * 1.6, 0.7, 'lowpass', 1, 0, at);
      return;
    }
    this.noise(0.025, 900 * pitch, v * 1.4, 1.2, 'bandpass', 1, 0, at);
    this.tone(110 * pitch, 0.06, 'sine', v, 70 / 110, 0, at);
  }

  jump(at?: At) {
    this.tone(300, 0.09, 'triangle', 0.08, 520 / 300, 0, at);
  }
  land(at?: At) {
    this.tone(80, 0.15, 'sine', 0.15, 0.7, 0, at);
    this.noise(0.15, 400, 0.12, 0.7, 'lowpass', 1, 0, at);
  }
  clap(at?: At) {
    this.noise(0.03, 1800, 0.25, 0.7, 'bandpass', 1, 0, at);
    this.noise(0.008, 3500, 0.2, 1, 'bandpass', 1, 0, at);
  }
  /** Small birds outside the window now and then. */
  birds(at?: At) {
    for (let i = 0; i < 3; i++) this.tone(2800 + Math.random() * 300, 0.06, 'sine', 0.03, 3400 / 2800, i * 0.11, at);
  }

  door(open: boolean, at?: At) {
    // creak: slowly sliding resonant saw
    this.tone(open ? 220 : 300, 0.5, 'sawtooth', 0.02, open ? 1.4 : 0.7, 0, at, 0.05);
    if (!open) this.thud(at, 0.6);
  }

  coffee(at?: At) {
    this.noise(1.6, 3000, 0.07, 0.7, 'highpass', 0.7, 0, at);
    this.tone(120, 1.4, 'sawtooth', 0.01, 1.1, 0, at, 0.2);
  }

  chair(at?: At) {
    // creak: low saw + band noise
    this.tone(90, 0.25, 'sawtooth', 0.03, 1.1, 0, at, 0.02);
    this.noise(0.25, 400, 0.05, 2, 'bandpass', 1, 0, at);
  }

  /** Animal-Crossing style babble: one syllable per character of the line, pitch per speaker. */
  voice(text: string, pitch: number, at?: At, tone: 'say' | 'alert' | 'think' = 'say') {
    if (!this.running) return;
    const clean = text.replace(/[^\p{L}\p{N}]/gu, '');
    const n = Math.min(10, Math.max(2, Math.round(clean.length / 4)));
    const question = text.trim().endsWith('?');
    const step = 1 / 11;
    for (let i = 0; i < n; i++) {
      let f0 = pitch * (0.85 + Math.random() * 0.4);
      if (question && i >= n - 2) f0 *= 1.15 + 0.12 * (i - (n - 2));
      this.syllable(f0, 600 + Math.random() * 1200, i * step, at, tone);
    }
    this.duckMusic(n * step + 0.3);
  }

  private syllable(f0: number, formant: number, delay: number, at: At, tone: 'say' | 'alert' | 'think') {
    const c = this.ctx!;
    const t = c.currentTime + delay;
    const g = c.createGain();
    const vol = 0.12 * (tone === 'think' ? 0.5 : 1);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.058);
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = formant;
    bp.Q.value = 4;
    let dest: AudioNode = this.out(at, 1);
    if (tone === 'think') {
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 800;
      lp.connect(dest);
      dest = lp;
    }
    g.connect(dest);
    bp.connect(g);
    const parts: [OscillatorType, number, number][] = [
      ['triangle', 1, 1],
      ['sine', 2, 0.3],
    ];
    if (tone === 'alert') parts.push(['square', 1.3, 0.25]);
    for (const [type, mult, amp] of parts) {
      const o = c.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f0 * mult, t);
      const a = c.createGain();
      a.gain.value = amp;
      o.connect(a).connect(bp);
      o.start(t);
      o.stop(t + 0.08);
    }
  }

  private musicBase = 0.3;
  /** First person sits the music a bit further back. */
  setMusicFocus(close: boolean) {
    this.musicBase = close ? 0.21 : 0.3;
    if (this.ctx && this.musicOn) this.music.gain.setTargetAtTime(this.musicBase, this.ctx.currentTime, 0.5);
  }

  /** Keep the music down while someone is really speaking. */
  duckFor(sec: number) {
    this.duckMusic(sec);
  }

  private duckMusic(sec: number) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.music.gain.cancelScheduledValues(t);
    const lvl = this.musicOn ? this.musicBase : 0;
    this.music.gain.setTargetAtTime(lvl * 0.45, t, 0.03);
    this.music.gain.setTargetAtTime(lvl, t + sec, 0.25);
  }

  // ------------------------------------------------------------------ UI / tease sounds

  pop(at?: At) {
    this.tone(420, 0.12, 'sine', 0.14, 2.2, 0, at);
  }
  ding(at?: At) {
    this.tone(880, 0.35, 'triangle', 0.12, 1, 0, at);
    this.tone(1320, 0.45, 'triangle', 0.08, 1, 0.12, at);
  }
  chime(at?: At) {
    [523, 659, 784, 1047].forEach((f, i) => {
      this.tone(f, 0.4, 'sine', 0.1, 1, i * 0.08, at);
      this.tone(f * 2, 0.3, 'triangle', 0.03, 1, i * 0.08, at);
    });
    this.noise(0.4, 6000, 0.03, 0.7, 'highpass', 1, 0.2, at);
    this.duckMusic(0.8);
  }
  boop(at?: At) {
    this.tone(660, 0.09, 'sine', 0.14, 1.6, 0, at);
  }
  bonk(at?: At, vol = 1) {
    this.tone(220, 0.12, 'triangle', 0.18 * vol, 0.5, 0, at);
    this.noise(0.06, 1200, 0.15 * vol, 1, 'bandpass', 1, 0, at);
  }
  thud(at?: At, vol = 1) {
    this.tone(90, 0.25, 'sine', 0.3 * vol, 0.6, 0, at);
    this.noise(0.12, 300, 0.22 * vol, 0.8, 'lowpass', 1, 0, at);
  }
  whoosh(at?: At) {
    this.noise(0.35, 400, 0.14, 0.7, 'bandpass', 5, 0, at);
  }
  splash(at?: At) {
    this.noise(0.35, 2500, 0.16, 0.6, 'highpass', 0.5, 0, at);
  }
  spray() {
    this.noise(0.08, 4000, 0.04, 0.5, 'highpass');
  }
  squeak(at?: At) {
    this.tone(1400, 0.1, 'square', 0.05, 0.6, 0, at);
    this.tone(900, 0.08, 'square', 0.05, 1, 0.1, at);
  }
  click(at?: At) {
    this.tone(1800, 0.03, 'square', 0.06, 1, 0, at);
  }
  giggle(at?: At) {
    for (let r = 0; r < 2; r++) [600, 750, 900].forEach((f, i) => this.tone(f + Math.random() * 40, 0.08, 'sine', 0.1, 1.2, r * 0.3 + i * 0.09, at));
  }
  /** Sharp open-hand slap. */
  slap(at?: At) {
    this.noise(0.06, 2600, 0.5, 0.6, 'highpass', 1, 0, at);
    this.noise(0.03, 1200, 0.3, 1.2, 'bandpass', 1, 0, at);
    this.tone(160, 0.08, 'sine', 0.2, 0.6, 0, at);
  }
  /** Duller thwack on the back of the head. */
  smack(at?: At) {
    this.noise(0.08, 900, 0.4, 0.9, 'bandpass', 0.7, 0, at);
    this.tone(140, 0.12, 'sine', 0.28, 0.5, 0, at);
  }

  /** Desk service bell: ding! */
  bell(at?: At) {
    this.tone(2350, 1.2, 'sine', 0.18, 1, 0, at, 0.002);
    this.tone(4700, 0.6, 'sine', 0.06, 1, 0, at, 0.002);
    this.tone(3130, 0.9, 'sine', 0.05, 1, 0, at, 0.002);
  }

  boing(at?: At) {
    this.tone(180, 0.22, 'sine', 0.16, 2.3, 0, at);
  }
  hmph(at?: At) {
    this.tone(180, 0.15, 'square', 0.05, 0.8, 0, at);
  }
  splat() {
    this.noise(0.14, 900, 0.25, 0.7, 'lowpass');
    this.tone(90, 0.18, 'sine', 0.25, 0.6);
  }

  // ------------------------------------------------------------------ generative lo-fi music

  private scheduleBar(t0: number) {
    const c = this.ctx!;
    const chord = PROGRESSION[this.bar % PROGRESSION.length];
    // warm electric-piano chord, soft attack, a little detune
    chord.forEach((m, i) => {
      for (const det of [-4, 4]) {
        const o = c.createOscillator();
        o.type = i === 0 ? 'triangle' : 'sine';
        o.frequency.value = midi(m);
        o.detune.value = det;
        const g = c.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.linearRampToValueAtTime(0.05, t0 + 0.06);
        g.gain.exponentialRampToValueAtTime(0.012, t0 + BAR * 0.9);
        g.gain.linearRampToValueAtTime(0.0001, t0 + BAR);
        const lp = c.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 1400;
        o.connect(lp).connect(g).connect(this.music);
        o.start(t0);
        o.stop(t0 + BAR + 0.05);
      }
    });
    // bass on beats 1 and 3
    for (const beat of [0, 2]) {
      const t = t0 + beat * BEAT;
      const o = c.createOscillator();
      o.type = 'sine';
      o.frequency.value = midi(chord[0] - 12);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.16, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + BEAT * 1.6);
      o.connect(g).connect(this.music);
      o.start(t);
      o.stop(t + BEAT * 1.7);
    }
    // a little pentatonic melody, sparse
    for (let s = 0; s < 8; s++) {
      if (Math.random() > 0.38) continue;
      const t = t0 + s * (BEAT / 2) + (s % 2 ? 0.04 : 0); // swing
      const note = chord[0] + 12 + PENTA[Math.floor(Math.random() * PENTA.length)];
      const o = c.createOscillator();
      o.type = 'triangle';
      o.frequency.value = midi(note);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.045, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      o.connect(g).connect(this.music);
      o.start(t);
      o.stop(t + 0.55);
    }
    // dusty drums: kick on 1 & 3, snare-ish on 2 & 4, hats on 8ths
    for (let b = 0; b < 4; b++) {
      const t = t0 + b * BEAT;
      if (b % 2 === 0) this.drum(t, 'kick');
      else this.drum(t, 'snare');
      this.drum(t + BEAT / 2 + 0.03, 'hat');
      this.drum(t, 'hat');
    }
    // vinyl crackle
    for (let i = 0; i < 6; i++) this.drum(t0 + Math.random() * BAR, 'crackle');
  }

  private drum(t: number, kind: 'kick' | 'snare' | 'hat' | 'crackle') {
    const c = this.ctx!;
    if (kind === 'kick') {
      const o = c.createOscillator();
      o.frequency.setValueAtTime(110, t);
      o.frequency.exponentialRampToValueAtTime(42, t + 0.18);
      const g = c.createGain();
      g.gain.setValueAtTime(0.22, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      o.connect(g).connect(this.music);
      o.start(t);
      o.stop(t + 0.3);
      return;
    }
    const src = c.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = c.createBiquadFilter();
    const g = c.createGain();
    const dur = kind === 'snare' ? 0.16 : kind === 'hat' ? 0.04 : 0.008;
    f.type = kind === 'snare' ? 'bandpass' : 'highpass';
    f.frequency.value = kind === 'snare' ? 1800 : kind === 'hat' ? 7000 : 3000;
    const vol = kind === 'snare' ? 0.07 : kind === 'hat' ? 0.025 : 0.03;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.music);
    src.start(t, Math.random());
    src.stop(t + dur + 0.02);
  }
}

const BPM = 72;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
// Cmaj7 – Am7 – Fmaj7 – G7 (as MIDI note numbers)
const PROGRESSION = [
  [48, 52, 55, 59],
  [45, 48, 52, 55],
  [53, 57, 60, 64],
  [55, 59, 62, 65],
];
const PENTA = [0, 2, 4, 7, 9, 12];
const midi = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
