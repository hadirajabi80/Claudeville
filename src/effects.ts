// Cheap particle effects: confetti bursts and coffee steam.
import * as THREE from 'three';
import { C } from './palette';

interface Particle {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  life: number;
  max: number;
  kind: 'confetti' | 'steam';
}

const CONFETTI_COLORS = [C.orange, C.cream, C.sage, C.sky, C.amber, C.terracotta];

export class Effects {
  private live: Particle[] = [];
  private pool: THREE.Mesh[] = [];
  private steamPool: THREE.Mesh[] = [];
  private confettiGeo = new THREE.BoxGeometry(0.035, 0.035, 0.008);
  private steamGeo = new THREE.SphereGeometry(0.03, 8, 6);

  constructor(private scene: THREE.Scene) {}

  confetti(at: THREE.Vector3, count = 44) {
    for (let i = 0; i < count; i++) {
      const m =
        this.pool.pop() ??
        new THREE.Mesh(this.confettiGeo, new THREE.MeshStandardMaterial({ roughness: 0.6, transparent: true, side: THREE.DoubleSide }));
      const mat = m.material as THREE.MeshStandardMaterial;
      mat.color.setHex(CONFETTI_COLORS[i % CONFETTI_COLORS.length]);
      mat.opacity = 1;
      m.position.copy(at);
      m.visible = true;
      this.scene.add(m);
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 1.2;
      this.live.push({
        mesh: m,
        vel: new THREE.Vector3(Math.cos(a) * r, 2 + Math.random() * 1.2, Math.sin(a) * r),
        spin: new THREE.Vector3(Math.random() * 12, Math.random() * 12, Math.random() * 12),
        life: 0,
        max: 1.6 + Math.random() * 0.4,
        kind: 'confetti',
      });
    }
  }

  steam(at: THREE.Vector3) {
    const m =
      this.steamPool.pop() ??
      new THREE.Mesh(this.steamGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false }));
    m.position.copy(at).add(new THREE.Vector3((Math.random() - 0.5) * 0.03, 0, (Math.random() - 0.5) * 0.03));
    m.scale.setScalar(0.6);
    m.visible = true;
    this.scene.add(m);
    this.live.push({ mesh: m, vel: new THREE.Vector3(0, 0.16, 0), spin: new THREE.Vector3(), life: 0, max: 1.6, kind: 'steam' });
  }

  update(dt: number) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      p.life += dt;
      const u = p.life / p.max;
      if (p.kind === 'confetti') {
        p.vel.y -= 6 * dt;
        p.vel.multiplyScalar(1 - 0.6 * dt);
        p.mesh.position.addScaledVector(p.vel, dt);
        if (p.mesh.position.y < 0.01) {
          p.mesh.position.y = 0.01;
          p.vel.set(0, 0, 0);
          p.spin.set(0, 0, 0);
        }
        p.mesh.rotation.x += p.spin.x * dt;
        p.mesh.rotation.y += p.spin.y * dt;
        p.mesh.rotation.z += p.spin.z * dt;
        (p.mesh.material as THREE.MeshStandardMaterial).opacity = u > 0.7 ? 1 - (u - 0.7) / 0.3 : 1;
      } else {
        p.mesh.position.addScaledVector(p.vel, dt);
        p.mesh.position.x += Math.sin(p.life * 4) * 0.002;
        p.mesh.scale.setScalar(0.6 + u * 1.2);
        (p.mesh.material as THREE.MeshBasicMaterial).opacity = 0.45 * (1 - u);
      }
      if (u >= 1) {
        p.mesh.visible = false;
        this.scene.remove(p.mesh);
        (p.kind === 'confetti' ? this.pool : this.steamPool).push(p.mesh);
        this.live.splice(i, 1);
      }
    }
  }
}
