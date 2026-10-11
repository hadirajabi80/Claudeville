export const C = {
  orange: 0xd97757,
  terracotta: 0xc2593a,
  cream: 0xf3ede3,
  warmWhite: 0xfaf7f2,
  sand: 0xe8dcc8,
  walnut: 0x8b5e3c,
  charcoal: 0x2b2b2e,
  sage: 0x8fa98a,
  sky: 0xbfd8e8,
  screen: 0x1b1e24,
  floor: 0xe3d5c0,
  mint: 0xa9d8c2,
  amber: 0xf2b84b,
  navy: 0x34405e,
};

export const hex = (n: number) => '#' + n.toString(16).padStart(6, '0');

export const SKIN = [0xf2c9a7, 0xd9a074, 0xa5673f, 0xf5d8c0];
export const HAIR = [0x3b2a20, 0x6b4a2f, 0x1f1b18, 0xc98b4a, 0x8a3b2a, 0x241a14, 0x4a2a1a];

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Small deterministic PRNG for repeatable per-character choices. */
export function rng(seed: number) {
  let a = seed || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
