// Live monitor content drawn into a CanvasTexture. Each tool type has its own look.
import * as THREE from 'three';
import type { Activity } from './types';

const W = 512;
const H = 320;
const KEYWORDS = ['const', 'let', 'function', 'return', 'import', 'export', 'if', 'else', 'await', 'async', 'class', 'new', 'for', 'type', 'interface'];
const IDENTS = ['agent', 'desk', 'render', 'state', 'pose', 'scene', 'event', 'session', 'stream', 'tool', 'result', 'config', 'update', 'office', 'camera', 'value', 'items', 'props'];
const STRINGS = ["'ok'", "'claude'", '`${id}`', "'/api/event'", "'utf8'", "'done'"];
const SHELL_OUT = [
  '✓ compiled 42 modules in 812ms',
  'PASS  src/office.test.ts (12 tests)',
  'added 3 packages, audited 61',
  '[main 3f9a2c1] update office',
  ' 2 files changed, 48 insertions(+)',
  'Server ready on 127.0.0.1:5199',
  '0 vulnerabilities found',
  'done in 1.42s',
  '→ build artifacts written to dist/',
  'ok  github.com/claude/office  0.214s',
];
const FILES = ['src/', '  main.ts', '  office.ts', '  agent.ts', '  pose.ts', '  world/', '    desk.ts', '    lounge.ts', 'server/', '  bridge.ts', 'package.json', 'README.md'];

type Mode = 'idle' | 'code' | 'read' | 'term' | 'tree' | 'web' | 'dispatch' | 'think' | 'wait';

interface Token {
  text: string;
  color: string;
}
type Line = { tokens: Token[]; mark?: '+' | '-' };

function rand<T>(a: T[]): T {
  return a[Math.floor(Math.random() * a.length)];
}

function codeLine(): Line {
  const r = Math.random();
  const indent = '  '.repeat(Math.floor(Math.random() * 3));
  if (r < 0.12) return { tokens: [{ text: indent + '// ' + rand(IDENTS) + ' ' + rand(IDENTS) + ' handling', color: '#6B7280' }] };
  if (r < 0.2) return { tokens: [{ text: '', color: '#fff' }] };
  const tk: Token[] = [{ text: indent, color: '#fff' }];
  tk.push({ text: rand(KEYWORDS) + ' ', color: '#D97757' });
  tk.push({ text: rand(IDENTS), color: '#E8DCC8' });
  if (Math.random() < 0.5) {
    tk.push({ text: ' = ', color: '#9CA3AF' });
    tk.push(Math.random() < 0.5 ? { text: rand(STRINGS), color: '#8FA98A' } : { text: String(Math.floor(Math.random() * 512)), color: '#BFD8E8' });
  } else {
    tk.push({ text: '(' + rand(IDENTS) + ') {', color: '#9CA3AF' });
  }
  return { tokens: tk };
}

export class Screen {
  readonly texture: THREE.CanvasTexture;
  private ctx: CanvasRenderingContext2D;
  private mode: Mode = 'idle';
  private title = '';
  private lines: Line[] = [];
  private acc = 0;
  private t = 0;
  private dirty = true;
  private scroll = 0;
  subagents: { name: string; done: boolean }[] = [];
  private power = true;
  private bootT = 0;

  get isOn() {
    return this.power;
  }

  setPower(on: boolean) {
    if (on === this.power) return;
    this.power = on;
    this.bootT = 0;
    this.dirty = true;
  }

  constructor() {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    this.ctx = c.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(c);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.draw();
  }

  get active() {
    return this.mode !== 'idle';
  }

  setActivity(a: Activity | null, waiting = false) {
    let m: Mode = 'idle';
    if (waiting) m = 'wait';
    else if (a)
      m = ({ think: 'think', read: 'read', write: 'code', run: 'term', search: 'tree', web: 'web', delegate: 'dispatch', todo: 'code', mcp: 'web', other: 'code' } as const)[a.kind];
    const title = a ? `${a.tool ?? 'Thinking'}${a.detail ? ' · ' + a.detail : ''}` : '';
    if (m !== this.mode) {
      this.mode = m;
      this.lines = [];
      this.scroll = 0;
      if (m === 'term') this.lines.push({ tokens: [{ text: '$ ' + (a?.detail ?? ''), color: '#E8FFE8' }] });
      if (m === 'code' && Math.random() < 0.6)
        for (let i = 0; i < 2; i++) this.lines.push({ ...codeLine(), mark: '-' });
      if (m === 'read') for (let i = 0; i < 30; i++) this.lines.push(codeLine());
    }
    this.title = title.length > 46 ? title.slice(0, 45) + '…' : title;
    this.dirty = true;
  }

  update(dt: number) {
    this.t += dt;
    this.acc += dt;
    this.bootT += dt;
    const interval = this.mode === 'idle' || !this.power ? 0.4 : 0.15;
    if (this.acc < interval && !this.dirty) return;
    this.acc = 0;
    this.dirty = false;
    this.step();
    this.draw();
    this.texture.needsUpdate = true;
  }

  private step() {
    switch (this.mode) {
      case 'code':
        if (Math.random() < 0.8) this.lines.push({ ...codeLine(), mark: '+' });
        break;
      case 'read':
        this.scroll += 0.5;
        break;
      case 'term':
        if (Math.random() < 0.35) this.lines.push({ tokens: [{ text: rand(SHELL_OUT), color: '#39D353' }] });
        break;
    }
    if (this.lines.length > 60) this.lines.splice(0, this.lines.length - 60);
  }

  private header(bg: string, fg: string) {
    const g = this.ctx;
    g.fillStyle = bg;
    g.fillRect(0, 0, W, 26);
    g.fillStyle = fg;
    g.font = 'bold 15px ui-monospace, Consolas, monospace';
    g.fillText(this.title || 'claude', 10, 18);
    for (let i = 0; i < 3; i++) {
      g.fillStyle = ['#FF6B6B', '#F2B84B', '#39D353'][i];
      g.beginPath();
      g.arc(W - 16 - i * 16, 13, 4.5, 0, Math.PI * 2);
      g.fill();
    }
  }

  private draw() {
    const g = this.ctx;
    const t = this.t;
    g.textBaseline = 'alphabetic';
    if (!this.power) {
      // switched off: black glass with a faint reflection and a dying white line
      g.fillStyle = '#050608';
      g.fillRect(0, 0, W, H);
      const k = Math.max(0, 1 - this.bootT * 4);
      if (k > 0) {
        g.fillStyle = `rgba(255,255,255,${k})`;
        g.fillRect(W / 2 - (W / 2) * k, H / 2 - 2, W * k, 4);
      }
      const grad = g.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0, 'rgba(255,255,255,0.07)');
      grad.addColorStop(0.5, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, W, H);
      return;
    }
    if (this.mode === 'idle') {
      g.fillStyle = '#14161B';
      g.fillRect(0, 0, W, H);
      // drifting sparkle screensaver
      const x = W / 2 + Math.sin(t * 0.4) * 150;
      const y = H / 2 + Math.cos(t * 0.31) * 80;
      drawSparkle(g, x, y, 26, 'rgba(217,119,87,0.55)', t * 0.5);
      return;
    }
    if (this.mode === 'term') {
      g.fillStyle = '#0B0F0A';
      g.fillRect(0, 0, W, H);
      this.header('#1A2018', '#9BE89B');
      this.drawLines(this.lines, 46, false);
      if (Math.floor(t * 2) % 2 === 0) {
        const n = Math.min(this.lines.length, 14);
        g.fillStyle = '#39D353';
        g.fillRect(14, 46 + n * 19 - 13, 9, 15);
      }
      return;
    }
    if (this.mode === 'web') {
      g.fillStyle = '#FAF7F2';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#E8DCC8';
      g.fillRect(0, 0, W, 30);
      g.fillStyle = '#fff';
      roundRect(g, 40, 6, W - 80, 18, 9);
      g.fill();
      g.fillStyle = '#555';
      g.font = '12px ui-sans-serif, Segoe UI, sans-serif';
      g.fillText(this.title, 52, 19);
      // spinner
      g.strokeStyle = '#D97757';
      g.lineWidth = 3;
      g.beginPath();
      g.arc(20, 15, 7, t * 6, t * 6 + 4);
      g.stroke();
      g.fillStyle = '#3A3F4A';
      roundRect(g, 30, 50, 280, 22, 6);
      g.fill();
      const off = (t * 20) % 40;
      for (let i = 0; i < 9; i++) {
        g.fillStyle = i % 4 === 0 ? '#D97757' : '#C9CCD3';
        const w = 160 + ((i * 97) % 280);
        g.fillRect(30, 92 + i * 24 - off, w, 9);
      }
      g.fillStyle = '#E3D5C0';
      roundRect(g, 340, 50, 140, 110, 10);
      g.fill();
      return;
    }
    g.fillStyle = '#1B1E24';
    g.fillRect(0, 0, W, H);
    if (this.mode === 'dispatch') {
      this.header('#2B2B2E', '#F3EDE3');
      g.font = 'bold 18px ui-sans-serif, Segoe UI, sans-serif';
      g.fillStyle = '#F3EDE3';
      g.fillText('Dispatching agents', 24, 62);
      const list = this.subagents.length ? this.subagents : [{ name: 'subagent', done: false }];
      list.slice(-7).forEach((s, i) => {
        const y = 100 + i * 30;
        g.fillStyle = s.done ? '#39D353' : `rgba(217,119,87,${0.55 + 0.45 * Math.sin(t * 5 + i)})`;
        g.beginPath();
        g.arc(34, y - 6, 7, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#E8DCC8';
        g.font = '16px ui-monospace, Consolas, monospace';
        g.fillText(s.name.slice(0, 40), 52, y);
      });
      return;
    }
    if (this.mode === 'tree') {
      this.header('#2B2B2E', '#F3EDE3');
      g.font = '16px ui-monospace, Consolas, monospace';
      const hi = Math.floor(t * 3) % FILES.length;
      FILES.forEach((f, i) => {
        const y = 50 + i * 21;
        if (i === hi) {
          g.fillStyle = 'rgba(217,119,87,0.25)';
          g.fillRect(0, y - 15, W, 20);
        }
        g.fillStyle = f.trim().endsWith('/') ? '#D97757' : '#E8DCC8';
        g.fillText((f.trim().endsWith('/') ? '▸ ' : '· ') + f, 16, y);
      });
      g.fillStyle = '#2E333D';
      g.fillRect(16, H - 14, W - 32, 5);
      g.fillStyle = '#D97757';
      g.fillRect(16, H - 14, (W - 32) * ((t / 2) % 1), 5);
      return;
    }
    if (this.mode === 'wait') {
      this.header('#2B2B2E', '#F3EDE3');
      g.fillStyle = `rgba(242,184,75,${0.75 + 0.25 * Math.sin(t * 4)})`;
      roundRect(g, 40, 110, W - 80, 90, 14);
      g.fill();
      g.fillStyle = '#2B2B2E';
      g.font = 'bold 24px ui-sans-serif, Segoe UI, sans-serif';
      g.fillText('Waiting for you…', 150, 165);
      return;
    }
    // code / read / think
    this.header('#2B2B2E', '#F3EDE3');
    if (this.mode === 'think') {
      g.fillStyle = '#E8DCC8';
      g.font = '15px ui-monospace, Consolas, monospace';
      g.fillText('thinking' + '.'.repeat(1 + (Math.floor(t * 2) % 3)), 40, 60);
      if (Math.floor(t * 2) % 2 === 0) {
        g.fillStyle = '#D97757';
        g.fillRect(40, 72, 9, 16);
      }
      return;
    }
    const read = this.mode === 'read';
    const start = read ? Math.floor(this.scroll) % Math.max(1, this.lines.length - 12) : 0;
    const vis = read ? this.lines.slice(start, start + 14) : this.lines;
    if (read) {
      g.fillStyle = 'rgba(217,119,87,0.18)';
      g.fillRect(0, 46 + 5 * 19 - 14, W, 19);
    }
    this.drawLines(vis, 46, true, read ? start : Math.max(0, this.lines.length - 14));
    if (!read && Math.floor(t * 2) % 2 === 0) {
      const n = Math.min(vis.length, 14);
      g.fillStyle = '#F3EDE3';
      g.fillRect(56, 46 + n * 19 - 13, 9, 15);
    }
  }

  private drawLines(lines: Line[], top: number, numbers: boolean, first = 0) {
    const g = this.ctx;
    const vis = lines.slice(-14);
    g.font = '15px ui-monospace, Consolas, monospace';
    vis.forEach((l, i) => {
      const y = top + i * 19;
      let x = numbers ? 56 : 14;
      if (numbers) {
        g.fillStyle = '#4B5563';
        g.fillText(String(first + i + 1).padStart(3, ' '), 8, y);
      }
      if (l.mark) {
        g.fillStyle = l.mark === '+' ? 'rgba(57,211,83,0.12)' : 'rgba(255,107,107,0.14)';
        g.fillRect(44, y - 14, W, 19);
        g.fillStyle = l.mark === '+' ? '#39D353' : '#FF6B6B';
        g.fillText(l.mark, 44, y);
      }
      for (const tk of l.tokens) {
        g.fillStyle = tk.color;
        g.fillText(tk.text, x, y);
        x += g.measureText(tk.text).width;
      }
    });
  }
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

export function drawSparkle(g: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, rot: number) {
  g.save();
  g.translate(x, y);
  g.rotate(rot);
  g.fillStyle = color;
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const rr = i % 2 === 0 ? r : r * 0.22;
    const px = Math.cos(a) * rr;
    const py = Math.sin(a) * rr;
    if (i === 0) g.moveTo(px, py);
    else g.lineTo(px, py);
  }
  g.closePath();
  g.fill();
  g.restore();
}
