// Billboard emotes above characters' heads (anger mark, sweat drop, hearts, zzz, stars…).
import * as THREE from 'three';

export type EmoteKind = 'anger' | 'sweat' | 'heart' | 'zzz' | 'exclaim' | 'question' | 'bulb' | 'stars' | 'music' | 'dizzy' | 'laugh' | 'slap' | 'smack';

const textures = new Map<EmoteKind, THREE.CanvasTexture>();

function draw(kind: EmoteKind): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const outline = (fill: string, path: () => void, w = 7) => {
    path();
    g.lineWidth = w;
    g.strokeStyle = '#ffffff';
    g.stroke();
    g.fillStyle = fill;
    g.fill();
  };
  const text = (s: string, size: number, color: string, x = 64, y = 64) => {
    g.font = `900 ${size}px "Segoe UI", system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 10;
    g.strokeStyle = '#fff';
    g.strokeText(s, x, y);
    g.fillStyle = color;
    g.fillText(s, x, y);
  };
  switch (kind) {
    case 'anger': {
      // the classic "vein" cross mark
      g.strokeStyle = '#fff';
      g.lineWidth = 26;
      const arcs = () => {
        for (let i = 0; i < 4; i++) {
          const a = (i * Math.PI) / 2 + Math.PI / 4;
          g.beginPath();
          g.arc(64 + Math.cos(a) * 44, 64 + Math.sin(a) * 44, 26, a + Math.PI * 0.62, a + Math.PI * 1.38);
          g.stroke();
        }
      };
      arcs();
      g.strokeStyle = '#E0393E';
      g.lineWidth = 14;
      arcs();
      break;
    }
    case 'sweat':
      outline('#7CC3F2', () => {
        g.beginPath();
        g.moveTo(64, 14);
        g.bezierCurveTo(90, 50, 100, 70, 92, 90);
        g.arc(64, 86, 30, 0.1, Math.PI - 0.1);
        g.bezierCurveTo(28, 70, 38, 50, 64, 14);
      });
      g.fillStyle = 'rgba(255,255,255,0.8)';
      g.beginPath();
      g.ellipse(54, 80, 6, 12, 0.3, 0, Math.PI * 2);
      g.fill();
      break;
    case 'heart':
      outline('#F0566B', () => {
        g.beginPath();
        g.moveTo(64, 110);
        g.bezierCurveTo(8, 70, 18, 14, 64, 40);
        g.bezierCurveTo(110, 14, 120, 70, 64, 110);
      });
      break;
    case 'zzz':
      text('z', 40, '#6B7FD7', 40, 92);
      text('z', 54, '#6B7FD7', 66, 64);
      text('Z', 66, '#6B7FD7', 92, 32);
      break;
    case 'exclaim':
      text('!', 110, '#E8A417');
      break;
    case 'question':
      text('?', 104, '#4C8FD6');
      break;
    case 'bulb':
      outline('#FFD84A', () => {
        g.beginPath();
        g.arc(64, 54, 36, Math.PI * 0.8, Math.PI * 2.2);
        g.lineTo(78, 96);
        g.lineTo(50, 96);
        g.closePath();
      });
      g.fillStyle = '#8A8F99';
      g.fillRect(50, 98, 28, 16);
      g.strokeStyle = '#FFF3B0';
      g.lineWidth = 5;
      for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 2 + (i - 2) * 0.55;
        g.beginPath();
        g.moveTo(64 + Math.cos(a) * 46, 54 + Math.sin(a) * 46);
        g.lineTo(64 + Math.cos(a) * 60, 54 + Math.sin(a) * 60);
        g.stroke();
      }
      break;
    case 'stars':
      for (const [x, y, r] of [
        [34, 70, 22],
        [70, 40, 26],
        [98, 78, 18],
      ]) {
        outline('#FFD23F', () => {
          g.beginPath();
          for (let i = 0; i < 10; i++) {
            const a = -Math.PI / 2 + (i * Math.PI) / 5;
            const rr = i % 2 ? r * 0.45 : r;
            g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
          }
          g.closePath();
        }, 6);
      }
      break;
    case 'music':
      text('♪', 70, '#D97757', 42, 74);
      text('♫', 62, '#8FA98A', 90, 46);
      break;
    case 'dizzy':
      g.strokeStyle = '#fff';
      g.lineWidth = 14;
      const spiral = () => {
        g.beginPath();
        for (let i = 0; i < 80; i++) {
          const a = i * 0.25;
          const r = 4 + i * 0.6;
          g.lineTo(64 + Math.cos(a) * r, 64 + Math.sin(a) * r);
        }
        g.stroke();
      };
      spiral();
      g.strokeStyle = '#9B6BD6';
      g.lineWidth = 7;
      spiral();
      break;
    case 'slap':
    case 'smack': {
      // comic starburst with the sound word
      g.beginPath();
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        const rr = i % 2 ? 40 : 62;
        g.lineTo(64 + Math.cos(a) * rr, 64 + Math.sin(a) * rr * 0.8);
      }
      g.closePath();
      g.fillStyle = kind === 'slap' ? '#FFD23F' : '#FF8A5B';
      g.strokeStyle = '#2B2B2E';
      g.lineWidth = 5;
      g.fill();
      g.stroke();
      text(kind === 'slap' ? 'SLAP!' : 'SMACK!', kind === 'slap' ? 30 : 25, '#E0393E');
      break;
    }
    case 'laugh':
      text('ha', 52, '#E8A417', 50, 80);
      text('ha!', 44, '#E8A417', 84, 40);
      break;
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function tex(kind: EmoteKind) {
  let t = textures.get(kind);
  if (!t) textures.set(kind, (t = draw(kind)));
  return t;
}

interface Live {
  sprite: THREE.Sprite;
  anchor: () => THREE.Vector3;
  t: number;
  dur: number;
  kind: EmoteKind;
  side: number;
}

/** Per-kind motion: where the emote sits relative to the head and how it moves. */
const STYLE: Record<EmoteKind, { size: number; dx: number; dy: number; spin?: number; rise?: number; bob?: number }> = {
  anger: { size: 0.3, dx: 0.22, dy: 0.05, bob: 0.03 },
  sweat: { size: 0.22, dx: -0.24, dy: 0.0, rise: -0.12 },
  heart: { size: 0.28, dx: 0, dy: 0.12, rise: 0.25 },
  zzz: { size: 0.34, dx: 0.2, dy: 0.12, rise: 0.15 },
  exclaim: { size: 0.34, dx: 0, dy: 0.12, bob: 0.02 },
  question: { size: 0.32, dx: 0, dy: 0.12, bob: 0.03 },
  bulb: { size: 0.34, dx: 0, dy: 0.16, bob: 0.02 },
  stars: { size: 0.42, dx: 0, dy: -0.02, spin: 3 },
  music: { size: 0.3, dx: 0.2, dy: 0.08, rise: 0.2 },
  dizzy: { size: 0.32, dx: 0, dy: 0.12, spin: -5 },
  laugh: { size: 0.34, dx: 0.18, dy: 0.06, bob: 0.04 },
  slap: { size: 0.5, dx: 0.12, dy: 0.12, spin: 0.4 },
  smack: { size: 0.5, dx: -0.1, dy: 0.18, spin: -0.4 },
};

export class Emotes {
  private live: Live[] = [];
  private tmp = new THREE.Vector3();

  constructor(private scene: THREE.Scene) {}

  show(anchor: () => THREE.Vector3, kind: EmoteKind, dur = 1.6) {
    // one emote of a kind per anchor: refresh instead of stacking
    const same = this.live.find((l) => l.anchor === anchor && l.kind === kind);
    if (same) {
      same.t = Math.min(same.t, 0.2);
      same.dur = Math.max(same.dur, dur);
      return;
    }
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex(kind), transparent: true, depthWrite: false, depthTest: false }));
    sprite.renderOrder = 10;
    this.scene.add(sprite);
    this.live.push({ sprite, anchor, t: 0, dur, kind, side: Math.random() < 0.5 ? -1 : 1 });
  }

  clear(anchor: () => THREE.Vector3) {
    for (const l of this.live) if (l.anchor === anchor) l.t = Math.max(l.t, l.dur - 0.2);
  }

  update(dt: number) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const l = this.live[i];
      l.t += dt;
      const s = STYLE[l.kind];
      const u = l.t / l.dur;
      const pop = l.t < 0.25 ? outBack(l.t / 0.25) : 1;
      const fade = u > 0.8 ? 1 - (u - 0.8) / 0.2 : 1;
      const p = this.tmp.copy(l.anchor());
      p.x += s.dx * 1.5 * (s.dx ? l.side : 1);
      p.y += s.dy - 0.14 + (s.rise ?? 0) * u + (s.bob ?? 0) * Math.sin(l.t * 9);
      l.sprite.position.copy(p);
      l.sprite.scale.setScalar(s.size * pop * (l.kind === 'anger' ? 1 + 0.12 * Math.max(0, Math.sin(l.t * 14)) : 1));
      l.sprite.material.rotation = (s.spin ?? 0) * l.t;
      l.sprite.material.opacity = fade;
      if (u >= 1) {
        this.scene.remove(l.sprite);
        l.sprite.material.dispose();
        this.live.splice(i, 1);
      }
    }
  }
}

function outBack(u: number) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(u - 1, 3) + c1 * Math.pow(u - 1, 2);
}
