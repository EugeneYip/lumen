// Procedural texture kit. Zero external assets - everything is synthesised at boot.
// Sprite profiles are stored gamma-encoded (see SPRITE_GAMMA) so the long dark
// tails of each glow survive 8-bit quantisation without banding.
import { textureArray, uploadLayer, texture2D } from './gl.js';
import { clamp01, smoothstep, TAU } from './math.js';
import { hash2, fbm2, noise2 } from './rng.js';

export const SPRITE_SIZE = 256;
export const SPRITE_GAMMA = 2.2;

/** Named layer indices into the sprite texture array. */
export const S = {
  GLOW: 0, CORE: 1, SPARK: 2, RING: 3, STREAK: 4, BOKEH: 5,
  PLANKTON: 6, BLOB: 7, STAR: 8, WISP: 9, CAUSTIC_SPOT: 10, HALO: 11,
  SHARD: 12, SMOKE: 13, THORN: 14, PETAL: 15,
};
export const SPRITE_LAYERS = 16;

const enc = (v) => Math.round(clamp01(Math.pow(clamp01(v), 1 / SPRITE_GAMMA)) * 255);

/** Runs fn(nx, ny, r, a) over a centred [-1,1] square; returns RGBA bytes. */
function paint(size, fn) {
  const px = new Uint8Array(size * size * 4);
  const inv = 2 / size;
  for (let y = 0; y < size; y++) {
    const ny = (y + 0.5) * inv - 1;
    for (let x = 0; x < size; x++) {
      const nx = (x + 0.5) * inv - 1;
      const r = Math.hypot(nx, ny);
      const a = Math.atan2(ny, nx);
      const v = fn(nx, ny, r, a);
      const i = (y * size + x) * 4;
      if (typeof v === 'number') { const e = enc(v); px[i] = e; px[i + 1] = e; px[i + 2] = e; px[i + 3] = e; }
      else { px[i] = enc(v[0]); px[i + 1] = enc(v[1]); px[i + 2] = enc(v[2]); px[i + 3] = enc(v[3] ?? v[0]); }
    }
  }
  return px;
}

// ---------------------------------------------------------------- profiles ---
const glow = (r) => {
  if (r >= 1) return 0;
  // Two-lobe: tight inverse-square-ish core + broad halo. Matches how a real
  // point emitter reads through a lens.
  const c = Math.exp(-r * r * 26);
  const halo = Math.pow(1 - r, 3.4) * 0.55;
  const veil = Math.pow(1 - r, 1.35) * 0.09;
  return clamp01(c + halo + veil);
};

const hotCore = (r) => (r >= 1 ? 0 : clamp01(Math.exp(-r * r * 90) + Math.pow(1 - r, 7) * 0.35));

function ring(r) {
  if (r >= 1) return 0;
  const t = (r - 0.72) / 0.16;
  const band = Math.exp(-t * t * 2.2);
  const inner = Math.exp(-Math.pow((r - 0.5) / 0.34, 2) * 3) * 0.1;
  return clamp01((band + inner) * (1 - smoothstep((r - 0.86) / 0.14)));
}

function star(nx, ny, r) {
  if (r >= 1) return 0;
  const c = glow(r) * 0.75;
  let blades = 0;
  for (let k = 0; k < 3; k++) {
    const ang = (k / 3) * Math.PI + 0.35;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const u = nx * ca + ny * sa, v = -nx * sa + ny * ca;
    blades += Math.exp(-Math.abs(v) * 90) * Math.pow(Math.max(0, 1 - Math.abs(u)), 2.5) * 0.5;
  }
  return clamp01(c + blades);
}

function streak(nx, ny) {
  const u = Math.abs(nx), v = Math.abs(ny);
  const body = Math.pow(Math.max(0, 1 - u), 2.2) * Math.exp(-v * v * 200);
  const wide = Math.pow(Math.max(0, 1 - u), 1.1) * Math.exp(-v * v * 26) * 0.28;
  return clamp01(body + wide);
}

function bokeh(nx, ny) {
  // Hexagonal aperture with soft edge + faint outer ring (optical vignetting).
  const k = 6, ang = Math.PI / k;
  let d = 0;
  for (let i = 0; i < k; i++) {
    const a = (i / k) * TAU + 0.2;
    d = Math.max(d, nx * Math.cos(a) + ny * Math.sin(a));
  }
  d /= Math.cos(ang);
  const edge = 1 - smoothstep((d - 0.68) / 0.16);
  const rim = Math.exp(-Math.pow((d - 0.66) / 0.08, 2)) * 0.5;
  const body = 0.42 + 0.18 * Math.pow(clamp01(d / 0.7), 3);
  return clamp01((body + rim) * edge);
}

function plankton(nx, ny, r, a) {
  if (r >= 1) return 0;
  // Tiny diatom: bright nucleus, glassy shell, six cilia.
  const nucleus = Math.exp(-r * r * 130);
  const shellR = 0.4;
  const shell = Math.exp(-Math.pow((r - shellR) / 0.075, 2)) * 0.55;
  let cilia = 0;
  for (let i = 0; i < 6; i++) {
    const t = (i / 6) * TAU;
    const dx = nx - Math.cos(t) * shellR * 1.5, dy = ny - Math.sin(t) * shellR * 1.5;
    cilia += Math.exp(-(dx * dx + dy * dy) * 260) * 0.3;
  }
  const halo = Math.pow(1 - r, 3) * 0.28;
  const ripple = 1 + 0.1 * Math.sin(a * 6 + r * 14);
  return clamp01(nucleus + shell * ripple + cilia + halo);
}

function blob(nx, ny, r, a) {
  if (r >= 1) return 0;
  const wob = 1 + 0.08 * Math.sin(a * 3) + 0.05 * Math.sin(a * 7 + 1.3);
  const rr = r / wob;
  return clamp01(Math.pow(Math.max(0, 1 - rr), 2.0) * 0.9 + Math.exp(-rr * rr * 9) * 0.35);
}

function wisp(nx, ny, r) {
  if (r >= 1) return 0;
  // Comma-shaped smear - good for motion-trail puffs.
  const cx = nx + 0.22, t = clamp01((cx + 0.8) / 1.6);
  const w = 0.10 + 0.30 * Math.sin(t * Math.PI);
  const yy = ny - Math.sin(t * Math.PI * 0.9) * 0.16;
  const body = Math.exp(-(yy * yy) / (w * w + 1e-5)) * Math.pow(Math.sin(t * Math.PI), 1.3);
  return clamp01(body * (1 - smoothstep((r - 0.85) / 0.15)));
}

function smoke(nx, ny, r) {
  if (r >= 1) return 0;
  const n = fbm2((nx + 3.11) * 3.2, (ny + 7.7) * 3.2, 5);
  const mask = Math.pow(Math.max(0, 1 - r), 2.1);
  return clamp01(mask * (0.35 + n * 1.15) * 0.9);
}

function shard(nx, ny) {
  // Long thin diamond - light shafts / debris.
  const u = Math.abs(nx), v = Math.abs(ny);
  const d = u * 0.35 + v * 1.0;
  return clamp01(Math.pow(Math.max(0, 1 - d), 3.0) * (1 - smoothstep((u - 0.9) / 0.1)));
}

function thorn(nx, ny, r, a) {
  if (r >= 1) return 0;
  // Urchin: tapered spines around a dense body - an occluder with a hot rim.
  const spines = 11;
  const k = Math.abs(Math.sin(a * spines * 0.5));
  const reach = 0.42 + 0.55 * Math.pow(k, 6);
  const body = 1 - smoothstep((r - reach) / 0.09);
  const rim = Math.exp(-Math.pow((r - reach) / 0.06, 2)) * 0.9;
  const inner = Math.exp(-r * r * 5) * 0.5;
  return clamp01(body * 0.55 + rim + inner * 0.4);
}

function petal(nx, ny, r, a) {
  if (r >= 1) return 0;
  const lobes = 5;
  const shape = 0.55 + 0.4 * Math.pow(Math.abs(Math.cos(a * lobes * 0.5)), 1.6);
  const rr = r / shape;
  const body = 1 - smoothstep((rr - 0.85) / 0.2);
  const veins = 0.15 * Math.exp(-Math.pow((Math.abs(Math.cos(a * lobes * 0.5)) - 1) * 12, 2));
  return clamp01(body * (0.35 + 0.5 * Math.pow(1 - rr, 1.5)) + veins);
}

function haloRing(r) {
  if (r >= 1) return 0;
  const t = (r - 0.9) / 0.09;
  return clamp01(Math.exp(-t * t * 3) * 0.9 + Math.pow(1 - r, 6) * 0.12);
}

function causticSpot(nx, ny, r) {
  if (r >= 1) return 0;
  const n = fbm2(nx * 2.4 + 11.3, ny * 2.4 - 4.7, 4);
  const ridged = 1 - Math.abs(n * 2 - 1);
  return clamp01(Math.pow(ridged, 2.4) * Math.pow(Math.max(0, 1 - r), 1.6) * 1.6);
}

// ------------------------------------------------------------------- build ---
export function buildSpriteArray(gl) {
  const tex = textureArray(gl, { width: SPRITE_SIZE, height: SPRITE_SIZE, layers: SPRITE_LAYERS });
  const P = SPRITE_SIZE;
  const put = (layer, fn) => uploadLayer(gl, tex, layer, P, P, paint(P, fn));

  put(S.GLOW, (x, y, r) => glow(r));
  put(S.CORE, (x, y, r) => hotCore(r));
  put(S.SPARK, (x, y, r) => clamp01(hotCore(r) * 1.1 + star(x, y, r) * 0.5));
  put(S.RING, (x, y, r) => ring(r));
  put(S.STREAK, (x, y) => streak(x, y));
  put(S.BOKEH, (x, y) => bokeh(x, y));
  put(S.PLANKTON, (x, y, r, a) => plankton(x, y, r, a));
  put(S.BLOB, (x, y, r, a) => blob(x, y, r, a));
  put(S.STAR, (x, y, r) => star(x, y, r));
  put(S.WISP, (x, y, r) => wisp(x, y, r));
  put(S.CAUSTIC_SPOT, (x, y, r) => causticSpot(x, y, r));
  put(S.HALO, (x, y, r) => haloRing(r));
  put(S.SHARD, (x, y) => shard(x, y));
  put(S.SMOKE, (x, y, r) => smoke(x, y, r));
  put(S.THORN, (x, y, r, a) => thorn(x, y, r, a));
  put(S.PETAL, (x, y, r, a) => petal(x, y, r, a));

  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
  gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
  return tex;
}

/** Tiling 4-octave noise packed into RGBA. Feeds fog, caustics, silt. */
export function buildNoiseTexture(gl, size = 256) {
  const px = new Uint8Array(size * size * 4);
  const oct = [1, 2, 4, 8];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      for (let c = 0; c < 4; c++) {
        const f = oct[c] * 4;
        const u = x / size, v = y / size;
        const s = (uu, vv) => noise2(uu * f, vv * f);
        const n = s(u, v) * (1 - u) * (1 - v) + s(u - 1, v) * u * (1 - v)
                + s(u, v - 1) * (1 - u) * v + s(u - 1, v - 1) * u * v;
        px[i + c] = Math.round(clamp01(n) * 255);
      }
    }
  }
  return texture2D(gl, { width: size, height: size, data: px, wrap: gl.REPEAT, mips: true });
}

/** Lens dirt / imperfection map, multiplied into the bloom. Sells "real optics". */
export function buildLensDirt(gl, size = 512) {
  const px = new Uint8Array(size * size * 4);
  const val = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    val[y * size + x] = 0.06 + 0.10 * fbm2(x / size * 6, y / size * 6, 4);
  }
  for (let i = 0; i < 420; i++) {
    const cx = hash2(i, 11) * size, cy = hash2(i, 23) * size;
    const rad = 1.2 + Math.pow(hash2(i, 37), 4) * 16;
    const amp = 0.25 + hash2(i, 53) * 0.85;
    const x0 = Math.max(0, (cx - rad) | 0), x1 = Math.min(size - 1, (cx + rad) | 0);
    const y0 = Math.max(0, (cy - rad) | 0), y1 = Math.min(size - 1, (cy + rad) | 0);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy) / rad;
      if (d < 1) val[y * size + x] += amp * Math.pow(1 - d, 2.2);
    }
  }
  for (let i = 0; i < 26; i++) {
    const a = hash2(i, 71) * TAU, L = size * (0.15 + hash2(i, 83) * 0.6);
    let x = hash2(i, 97) * size, y = hash2(i, 101) * size;
    const dx = Math.cos(a), dy = Math.sin(a), amp = 0.18 + hash2(i, 103) * 0.4;
    for (let s = 0; s < L; s++) {
      const w = 1.0 + 1.6 * Math.sin((s / L) * Math.PI);
      for (let o = -3; o <= 3; o++) {
        const px2 = Math.round(x - dy * o) & (size - 1), py2 = Math.round(y + dx * o) & (size - 1);
        val[py2 * size + px2] += amp * Math.exp(-(o * o) / (w * w)) * Math.sin((s / L) * Math.PI);
      }
      x += dx; y += dy;
    }
  }
  for (let i = 0; i < size * size; i++) {
    const v = Math.round(clamp01(val[i]) * 255);
    px[i * 4] = v; px[i * 4 + 1] = v; px[i * 4 + 2] = v; px[i * 4 + 3] = 255;
  }
  return texture2D(gl, { width: size, height: size, data: px, wrap: gl.REPEAT, mips: true });
}

/** 1-D LUT strip used for spectral / chromatic sampling in post. */
export function buildSpectrumTexture(gl, width = 256) {
  const px = new Uint8Array(width * 4);
  for (let i = 0; i < width; i++) {
    const t = i / (width - 1);
    const r = clamp01(smoothstep((t - 0.42) / 0.35) * 1.15 + Math.exp(-Math.pow((t - 0.02) / 0.14, 2)) * 0.5);
    const g = clamp01(Math.exp(-Math.pow((t - 0.5) / 0.30, 2)) * 1.1);
    const b = clamp01(Math.exp(-Math.pow((t - 0.18) / 0.26, 2)) * 1.15 + (1 - smoothstep((t - 0.5) / 0.4)) * 0.2);
    px[i * 4] = Math.round(r * 255); px[i * 4 + 1] = Math.round(g * 255);
    px[i * 4 + 2] = Math.round(b * 255); px[i * 4 + 3] = 255;
  }
  return texture2D(gl, { width, height: 1, data: px, wrap: gl.CLAMP_TO_EDGE });
}

export function buildAll(gl) {
  return {
    sprites: buildSpriteArray(gl),
    noise: buildNoiseTexture(gl, 256),
    dirt: buildLensDirt(gl, 512),
    spectrum: buildSpectrumTexture(gl, 256),
  };
}
