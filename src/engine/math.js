// Small, allocation-free math kit. Angles in radians. Screen-space Y is down.
export const TAU = Math.PI * 2;
export const PI = Math.PI;
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const remap = (v, a, b, c, d) => lerp(c, d, clamp01(invLerp(a, b, v)));
export const smoothstep = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };
export const smootherstep = (t) => { t = clamp01(t); return t * t * t * (t * (t * 6 - 15) + 10); };
export const sign = Math.sign;

/** Frame-rate independent exponential approach. `rate` = 1/e-folds per second. */
export const damp = (cur, target, rate, dt) => target + (cur - target) * Math.exp(-rate * dt);
/** Same, but for angles (shortest arc). */
export const dampAngle = (cur, target, rate, dt) => cur + shortAngle(cur, target) * (1 - Math.exp(-rate * dt));
export const shortAngle = (a, b) => { let d = (b - a) % TAU; if (d > PI) d -= TAU; if (d < -PI) d += TAU; return d; };

/** Critically-damped spring. Returns [pos, vel]. Stable for large dt. */
export function spring(pos, vel, target, freq, damping, dt) {
  const w = TAU * freq, z = damping;
  const f = 1 + 2 * dt * z * w, oo = w * w, hoo = dt * oo, hhoo = dt * hoo;
  const det = 1 / (f + hhoo);
  const dp = (f * pos + dt * vel + hhoo * target) * det;
  const dv = (vel + hoo * (target - pos)) * det;
  return [dp, dv];
}

export const len = (x, y) => Math.hypot(x, y);
export const len2 = (x, y) => x * x + y * y;
export const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);
export const dist2 = (ax, ay, bx, by) => { const dx = bx - ax, dy = by - ay; return dx * dx + dy * dy; };
export const dot = (ax, ay, bx, by) => ax * bx + ay * by;
export const cross = (ax, ay, bx, by) => ax * by - ay * bx;

/** Distance from point p to segment ab. */
export function distToSeg(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const t = clamp01((px - ax) * abx + (py - ay) * aby === 0 && abx === 0 && aby === 0
    ? 0 : ((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby || 1));
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
}

// ---- easing ----
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
export const easeOutQuint = (t) => 1 - Math.pow(1 - t, 5);
export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOutBack = (t) => { const c = 1.70158, c3 = c + 1; return 1 + c3 * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
export const easeOutElastic = (t) => t === 0 ? 0 : t === 1 ? 1
  : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (TAU / 3)) + 1;
export const pulse = (t, k = 8) => Math.exp(-k * t) * Math.sin(t * 40);

// ---- color ----
/** hex 0xRRGGBB -> [r,g,b] linear-ish 0..1 (sRGB decode). */
export function hexToLin(hex) {
  const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255;
  const d = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return [d(r), d(g), d(b)];
}
export function hsl(h, s, l) {
  h = ((h % 1) + 1) % 1;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => { const k = (n + h * 12) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)];
}
/** Perceptual-ish mix in linear space with gamma-correct feel. */
export function mixCol(a, b, t, out = [0, 0, 0]) {
  out[0] = lerp(a[0], b[0], t); out[1] = lerp(a[1], b[1], t); out[2] = lerp(a[2], b[2], t);
  return out;
}
