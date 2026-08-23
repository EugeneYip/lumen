// Deterministic RNG + noise. Everything world-gen touches must come from here.

/** mulberry32 — fast, good enough, 2^32 period. */
export function makeRng(seed = 1) {
  let a = (seed | 0) || 1;
  const f = () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  f.range = (lo, hi) => lo + f() * (hi - lo);
  f.int = (lo, hi) => Math.floor(lo + f() * (hi - lo + 1));
  f.pick = (arr) => arr[Math.floor(f() * arr.length) % arr.length];
  f.sign = () => (f() < 0.5 ? -1 : 1);
  f.chance = (p) => f() < p;
  /** Box-Muller, unit normal. */
  f.normal = () => Math.sqrt(-2 * Math.log(1 - f())) * Math.cos(6.283185307179586 * f());
  f.fork = () => makeRng((f() * 4294967296) | 0);
  return f;
}

// ---- integer hashes ----
export function hash1(n) {
  n = (n << 13) ^ n;
  return ((n * (n * n * 15731 + 789221) + 1376312589) & 0x7fffffff) / 0x7fffffff;
}
export function hash2(x, y) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = (h ^ (h >>> 13)) | 0; h = Math.imul(h, 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ---- value noise ----
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
export function noise1(x) {
  const i = Math.floor(x), f = x - i;
  return hash1(i) * (1 - fade(f)) + hash1(i + 1) * fade(f);
}
export function noise2(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = fade(x - ix), fy = fade(y - iy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}
export function fbm1(x, oct = 4, lac = 2, gain = 0.5) {
  let s = 0, amp = 0.5, freq = 1, norm = 0;
  for (let i = 0; i < oct; i++) { s += amp * noise1(x * freq); norm += amp; amp *= gain; freq *= lac; }
  return s / norm;
}
export function fbm2(x, y, oct = 4, lac = 2, gain = 0.5) {
  let s = 0, amp = 0.5, freq = 1, norm = 0;
  for (let i = 0; i < oct; i++) { s += amp * noise2(x * freq, y * freq); norm += amp; amp *= gain; freq *= lac; }
  return s / norm;
}
/** Ridged noise, good for rock silhouettes. */
export function ridge1(x, oct = 4) {
  let s = 0, amp = 0.5, freq = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    s += amp * (1 - Math.abs(noise1(x * freq) * 2 - 1)); norm += amp; amp *= 0.5; freq *= 2;
  }
  return s / norm;
}
