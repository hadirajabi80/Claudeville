// "Pick your character": male or female avatar with live 3D previews and a name.
import * as THREE from 'three';
import { buildCharacter, PLAYER_VARIANT, type Gender, type Rig } from './character';
import { randomName } from './names';
import * as P from './pose';

export interface AvatarChoice {
  gender: Gender;
  name: string;
}

const KEY = 'office-avatar';

export function savedAvatar(): AvatarChoice | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (v && (v.gender === 'm' || v.gender === 'f')) return { gender: v.gender, name: String(v.name || 'You').slice(0, 16) };
  } catch {
    /* ignore */
  }
  return null;
}

export class AvatarPicker {
  private el = document.getElementById('avatar')!;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(32, 2, 0.1, 20);
  private rigs: Record<Gender, Rig | null> = { m: null, f: null };
  private gender: Gender = 'm';
  private nameEdited = false;
  private input!: HTMLInputElement;
  private raf = 0;
  private done: ((c: AvatarChoice | null) => void) | null = null;
  private canClose = false;

  constructor() {
    this.el.innerHTML = `
      <div class="card">
        <h2>Pick your character</h2>
        <div class="stage"><canvas width="600" height="300"></canvas>
          <div class="labels"><button data-g="m">Male</button><button data-g="f">Female</button></div>
        </div>
        <label>Name <div class="row"><input maxlength="16" spellcheck="false" /><button class="dice" title="Random name">⟳</button></div></label>
        <div class="actions"><span class="hint">← → to switch · Enter to start</span><button class="start">Start</button></div>
      </div>`;
    this.input = this.el.querySelector('input')!;
    this.el.querySelectorAll<HTMLButtonElement>('[data-g]').forEach((b) => (b.onclick = () => this.select(b.dataset.g as Gender)));
    this.el.querySelector<HTMLButtonElement>('.dice')!.onclick = () => {
      this.nameEdited = false;
      this.input.value = randomName(this.gender);
    };
    this.el.querySelector<HTMLButtonElement>('.start')!.onclick = () => this.finish(true);
    this.input.addEventListener('input', () => (this.nameEdited = true));
    this.el.addEventListener('keydown', (e) => {
      e.stopPropagation(); // never move the player or fire hotkeys while picking
      if (e.key === 'Enter') this.finish(true);
      else if (e.key === 'Escape' && this.canClose) this.finish(false);
      else if (e.target !== this.input && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) this.select(this.gender === 'm' ? 'f' : 'm');
    });
    this.el.addEventListener('keyup', (e) => e.stopPropagation());
    this.el.addEventListener('pointerdown', (e) => {
      if (e.target === this.el && this.canClose) this.finish(false);
    });
  }

  get isOpen() {
    return this.el.classList.contains('open');
  }

  /** Resolves with the choice, or null if closed without choosing (only possible when re-opened). */
  open(current: AvatarChoice | null): Promise<AvatarChoice | null> {
    this.canClose = !!current;
    this.gender = current?.gender ?? 'm';
    this.nameEdited = !!current;
    this.input.value = current?.name ?? randomName(this.gender);
    this.setupPreview();
    this.select(this.gender, true);
    this.el.classList.add('open');
    setTimeout(() => this.el.querySelector<HTMLButtonElement>('.start')!.focus(), 30);
    return new Promise((res) => (this.done = res));
  }

  private select(g: Gender, keepName = false) {
    this.gender = g;
    this.el.querySelectorAll<HTMLButtonElement>('[data-g]').forEach((b) => b.classList.toggle('on', b.dataset.g === g));
    if (!keepName && !this.nameEdited) this.input.value = randomName(g);
  }

  private finish(ok: boolean) {
    const name = this.input.value.trim().slice(0, 16) || randomName(this.gender);
    const choice = ok ? { gender: this.gender, name } : null;
    if (choice) {
      try {
        localStorage.setItem(KEY, JSON.stringify({ v: 1, ...choice }));
      } catch {
        /* ignore */
      }
    }
    this.el.classList.remove('open');
    cancelAnimationFrame(this.raf);
    this.done?.(choice);
    this.done = null;
  }

  private setupPreview() {
    if (!this.renderer) {
      const canvas = this.el.querySelector('canvas')!;
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
      this.renderer.setPixelRatio(1);
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.scene.add(new THREE.HemisphereLight(0xfff4e6, 0xc9b79c, 1.4));
      const sun = new THREE.DirectionalLight(0xffe9cf, 2);
      sun.position.set(2, 4, 3);
      this.scene.add(sun);
      this.camera.position.set(0, 0.9, 3.0);
      this.camera.lookAt(0, 0.68, 0);
      for (const g of ['m', 'f'] as Gender[]) {
        const rig = buildCharacter(PLAYER_VARIANT, 'preview:' + g, g);
        rig.root.position.x = g === 'm' ? -0.48 : 0.48;
        this.scene.add(rig.root);
        this.rigs[g] = rig;
      }
    }
    const pose = P.blank();
    const t0 = performance.now();
    const loop = () => {
      const t = (performance.now() - t0) / 1000;
      for (const g of ['m', 'f'] as Gender[]) {
        const rig = this.rigs[g]!;
        const on = g === this.gender;
        for (const j of Object.keys(pose.r) as (keyof typeof pose.r)[]) pose.r[j] = [0, 0, 0];
        P.standIdle(pose, t + (g === 'f' ? 1.3 : 0), { seed: g === 'f' ? 0.7 : 0.2, glanceAt: 0, glanceDir: 0 });
        if (on) P.arm(pose, 'R', 2.7, -0.3 + 0.3 * Math.sin(t * 10), 0.4); // the selected one waves
        for (const j of Object.keys(pose.r) as (keyof typeof pose.r)[]) rig.joints[j].rotation.set(...pose.r[j]);
        rig.body.position.y = pose.lift;
        rig.root.rotation.y += ((on ? Math.sin(t * 0.8) * 0.5 : 0) - rig.root.rotation.y) * 0.08;
        const s = on ? 1.08 : 0.9;
        rig.root.scale.setScalar(rig.root.scale.x + (s - rig.root.scale.x) * 0.15);
        for (const m of rig.materials) {
          m.transparent = !on;
          m.opacity = on ? 1 : 0.55;
        }
      }
      this.renderer!.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(loop);
    };
    cancelAnimationFrame(this.raf);
    loop();
  }
}
