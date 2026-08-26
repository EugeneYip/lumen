// Procedural texture kit. Zero external assets - everything is synthesised at boot.
//
// Sprite profiles are single-channel: the sprite shader samples only .a (see
// sprites.js), so a layer cannot carry colour. All four bytes hold the same
// gamma-encoded value (SPRITE_GAMMA) so the long dark tails of a glow survive
// 8-bit quantisation without banding. Colour comes from the per-instance HDR
// tint, which means anything that should read as spectral has to come from thin
// high-contrast structure for the post chain's chromatic aberration to grab.
//
// ---------------------------------------------------------------------------
// THE FALLOFF FAMILY - read this before picking a layer.
//
// One blur radius for everything reads as a filter; layering different falloffs
// reads as light. Four deliberately different characters, bottom to top:
//
//   VEIL    Widest, faintest, no core at all. Peaks at ~0.5 so several can
//           stack without clipping. Draw at 2-4x the object and dim - this is
//           the layer that puts a light *in water* rather than on top of it.
//   VOLUME  A lit ball of fog: flattened shoulder (the chord integral through a
//           sphere), a defined rim, and a little spill past it. Draw at roughly
//           object size. Use it to give something mass and an edge.
//   GLOW    The workhorse mid glow - tight core, defined halo, short tail.
//           Deliberately UNCHANGED from the original build: it is drawn at
//           11 sites and every existing composition is balanced against it.
//   CORE    Near-delta hot point, very high dynamic range, almost no tail.
//           Draw SMALL (0.5-1.5x the object) with gain > 1. This is the bit
//           that clears the bloom threshold and reads as a specular hit.
//
// Rims and fronts:
//   HALO    Thin optical rim (bubble edge, lens ring). Keeps a faint interior
//           so it still reads as a soft dot when drawn at 4-14px.
//   RING    An expanding shock, NOT a donut: near-vacuum outside a thin bright
//           leading front, then a wake decaying inward, with radius and
//           brightness varying around the circle. The leading edge sits at
//           r~0.76 (the old profile peaked at 0.72) so caller geometry is
//           essentially unchanged.
//   SHOCK   The violent version of RING - thicker front, deeper wake, coarse
//           radial striations and a central flash. For impacts.
//
// Streaks:
//   STREAK    Tight anamorphic flare with striations along its length. Callers
//             already stretch this 4:1 to 13:1, so the profile is only
//             moderately thin - do not squash it further in the texture.
//   ANAMORPH  Much wider, softer, longer. For big slow lights where STREAK
//             would read as a hard scratch.
//
// Added in this pass. Additive only - nothing was renumbered, because
// render.js and particles.js reference these by name and cannot be edited here:
//   16 VEIL       wide soft scatter          17 VOLUME    volumetric ball
//   18 SHOCK      impact shockwave           19 ANAMORPH  wide lens streak
//   20 FILAMENT   single tapered hair (tentacles, frayed tether strands)
//   21 LEAF       broad soft-edged blade with a ROUNDED tip (kelp fronds)
//
// LEAF exists because neither of the two long profiles could be a leaf. SHARD
// is a straight taper to a POINT, and a point reads as a thorn at any
// orientation - that is what made the kelp beds read as barbed wire through
// four review rounds. FILAMENT curves, but its half-width is 0.013 of its quad,
// so a blade of thickness T would need a quad 77T tall. See pLeaf.
//
// Currently unused by render.js/particles.js, and therefore kept deliberately
// cheap to build: BOKEH, WISP, CAUSTIC_SPOT, SHARD. SHARD was reached until now
// only through render.js's LY('LEAF', S.SHARD) fallback - i.e. it was the kelp
// blade, and it is the layer postfx.js's note back-solved the four-review "ruled
// diagonal" to. LEAF supersedes it there; nothing draws SHARD any more.
//
// Boot cost note: the whole kit is on a budget, and the two things that blow it
// are (a) a transcendental per pixel and (b) calling hash2 inside a per-pixel
// feature loop. So the gamma encode is a lookup, purely radial profiles are
// built from a 1-D table, angular modulation is tabulated, and every per-blade
// or per-spine constant is hoisted into a flat table before the pixel loop.
// ---------------------------------------------------------------------------
import { textureArray, uploadLayer, texture2D } from './gl.js';
import { clamp01, smoothstep, TAU } from './math.js';
import { hash2 } from './rng.js';

export const SPRITE_SIZE = 256;
export const SPRITE_GAMMA = 2.2;

/** Named layer indices into the sprite texture array. Additive only. */
export const S = {
  GLOW: 0, CORE: 1, SPARK: 2, RING: 3, STREAK: 4, BOKEH: 5,
  PLANKTON: 6, BLOB: 7, STAR: 8, WISP: 9, CAUSTIC_SPOT: 10, HALO: 11,
  SHARD: 12, SMOKE: 13, THORN: 14, PETAL: 15,
  VEIL: 16, VOLUME: 17, SHOCK: 18, ANAMORPH: 19, FILAMENT: 20,
  LEAF: 21,
};
export const SPRITE_LAYERS = 22;

/** One texel in the [-1,1] paint space. */
const TEXEL = 2 / SPRITE_SIZE;
// Nothing may transition faster than this, or it aliases and shimmers under
// motion. Every Gaussian half-width below is clamped to it, which is what lets
// the whole kit skip supersampling and still stay inside the boot budget.
const MIN_SOFT = TEXEL * 1.7;

// Gamma encode as a lookup, indexed by sqrt(v). A linear index would quantise
// exactly the faint tails that SPRITE_GAMMA exists to protect; sqrt puts the
// resolution where the curve is steep.
const G_N = 8192;
const GLUT = new Uint8Array(G_N + 1);
for (let i = 0; i <= G_N; i++) {
  const s = i / G_N;
  GLUT[i] = Math.round(Math.pow(s * s, 1 / SPRITE_GAMMA) * 255);
}
const enc = (v) => GLUT[(Math.sqrt(v < 0 ? 0 : v > 1 ? 1 : v) * G_N) | 0];

/** Stored byte -> linear. Needed to build the mip chain in the right space. */
const DEC = new Float32Array(256);
for (let i = 0; i < 256; i++) DEC[i] = Math.pow(i / 255, SPRITE_GAMMA);

/**
 * Mip chain, built by hand in LINEAR space.
 *
 * gl.generateMipmap box-filters the STORED bytes, and the store is gamma
 * encoded - so it averages the wrong quantity. Averaging in gamma space is not
 * averaging: one bright texel beside three dark ones decodes to 0.047 instead
 * of 0.25. High-contrast structure therefore bleeds energy out of the peak at
 * every level while a flat faint tail survives exactly, so a few levels down
 * the core has died, the tail dominates, and the whole tile decodes to a
 * near-uniform grey. That is the flat grey square a sprite drawn at 8-12px
 * turned into - dozens of them per frame, reading as untextured debug quads.
 *
 * Decode to linear, box-filter 2x2, re-encode, upload each level. Energy is
 * conserved, so a small dot stays a small dot.
 */
function uploadMips(gl, tex, layer, size, bytes) {
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
  let w = size, h = size;
  let lin = new Float32Array(w * h);
  for (let i = 0, p = 3; i < lin.length; i++, p += 4) lin[i] = DEC[bytes[p]];
  let level = 0;
  while (w > 1 || h > 1) {
    const nw = w > 1 ? w >> 1 : 1, nh = h > 1 ? h >> 1 : 1;
    const next = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) {
      const y0 = Math.min(y * 2, h - 1) * w, y1 = Math.min(y * 2 + 1, h - 1) * w;
      for (let x = 0; x < nw; x++) {
        const x0 = Math.min(x * 2, w - 1), x1 = Math.min(x * 2 + 1, w - 1);
        next[y * nw + x] = (lin[y0 + x0] + lin[y0 + x1] + lin[y1 + x0] + lin[y1 + x1]) * 0.25;
      }
    }
    w = nw; h = nh; lin = next; level++;
    const out = new Uint8Array(w * h * 4);
    const o32 = new Uint32Array(out.buffer);
    for (let i = 0; i < lin.length; i++) o32[i] = enc(lin[i]) * 0x01010101;
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, level, 0, 0, layer, w, h, 1,
                     gl.RGBA, gl.UNSIGNED_BYTE, out);
  }
}

/**
 * Runs fn(nx, ny, r, a) over a centred [-1,1] square; returns RGBA bytes.
 * `wantAngle` gates the atan2, which costs about as much as a whole cheap
 * profile and most layers never look at the angle.
 */
function paint(size, fn, wantAngle = false) {
  const px = new Uint8Array(size * size * 4);
  const w32 = new Uint32Array(px.buffer);
  const inv = 2 / size;
  let i = 0;
  for (let y = 0; y < size; y++) {
    const ny = (y + 0.5) * inv - 1, ny2 = ny * ny;
    for (let x = 0; x < size; x++, i++) {
      const nx = (x + 0.5) * inv - 1;
      const r = Math.sqrt(nx * nx + ny2);
      const v = fn(nx, ny, r, wantAngle ? Math.atan2(ny, nx) : 0);
      w32[i] = enc(v) * 0x01010101;   // same byte in all four channels
    }
  }
  return px;
}

/**
 * Purely radial profiles: tabulate the encoded word over r once, then the fill
 * is a sqrt and a table read. Takes those layers from ~18ms each to ~3ms.
 */
function paintRadial(size, fn) {
  const px = new Uint8Array(size * size * 4);
  const w32 = new Uint32Array(px.buffer);
  const RN = 4096, RMAX = Math.SQRT2;
  const lut = new Uint32Array(RN + 2);
  for (let i = 0; i <= RN + 1; i++) lut[i] = enc(fn((i / RN) * RMAX)) * 0x01010101;
  const inv = 2 / size, k = RN / RMAX;
  let i = 0;
  for (let y = 0; y < size; y++) {
    const ny = (y + 0.5) * inv - 1, ny2 = ny * ny;
    for (let x = 0; x < size; x++, i++) {
      const nx = (x + 0.5) * inv - 1;
      w32[i] = lut[(Math.sqrt(nx * nx + ny2) * k) | 0];
    }
  }
  return px;
}

// ------------------------------------------------------------------- noise ---
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * Periodic value noise: the lattice index wraps at `per`, so the result is
 * exactly seamless for any integer period. The old buildNoiseTexture faked
 * tiling with a 4-corner cross-fade, which collapsed the variance in the middle
 * of the tile and left dark knots at the corners - visible as a plaid.
 */
function pnoise(x, y, per) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = fade(x - ix), fy = fade(y - iy);
  const x0 = ((ix % per) + per) % per, y0 = ((iy % per) + per) % per;
  const x1 = (x0 + 1) % per, y1 = (y0 + 1) % per;
  const a = hash2(x0, y0), b = hash2(x1, y0), c = hash2(x0, y1), d = hash2(x1, y1);
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/** Tiling fbm over uv in [0,1). `base` is the integer cell count of octave 0. */
function pfbm(u, v, base, oct) {
  let s = 0, amp = 0.5, f = base, norm = 0;
  for (let i = 0; i < oct; i++) {
    // integer per-octave offsets decorrelate the axis-aligned value-noise grid
    // without breaking periodicity (an integer shift preserves the period)
    s += amp * pnoise(u * f + i * 7, v * f + i * 13, f);
    norm += amp; amp *= 0.5; f *= 2;
  }
  return s / norm;
}

/** Ridged variant - gives filaments and creases rather than lumps. */
function pridge(u, v, base, oct) {
  let s = 0, amp = 0.5, f = base, norm = 0;
  for (let i = 0; i < oct; i++) {
    const n = pnoise(u * f + i * 5, v * f + i * 11, f);
    s += amp * (1 - Math.abs(n * 2 - 1)); norm += amp; amp *= 0.5; f *= 2;
  }
  return s / norm;
}

function mkField(res, base, oct, ridged = false) {
  const out = new Float32Array(res * res);
  for (let y = 0; y < res; y++) {
    const v = y / res;
    for (let x = 0; x < res; x++) {
      out[y * res + x] = ridged ? pridge(x / res, v, base, oct) : pfbm(x / res, v, base, oct);
    }
  }
  return out;
}

/** Wrapped bilinear sample of a field built by mkField. */
function sampleF(f, res, u, v) {
  const x = u * res - 0.5, y = v * res - 0.5;
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const x0 = ((ix % res) + res) % res, y0 = ((iy % res) + res) % res;
  const x1 = (x0 + 1) % res, y1 = (y0 + 1) % res;
  const a = f[y0 * res + x0], b = f[y0 * res + x1];
  const c = f[y1 * res + x0], d = f[y1 * res + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

// Shared detail fields, built once per boot and bilinear-sampled from the paint
// loops. Multi-octave fbm evaluated per pixel across 21 layers is exactly what
// blows the boot budget; a 128 field costs a fraction and the difference is
// invisible underneath a glow.
const NRES = 128;
let FA = null, FB = null;
// Sprites sample a *window* of the field (scale < 0.5) so it never visibly
// repeats inside one sprite; ox/oy pick a different window per layer.
/** Coarse fibre, 0..1. x,y in [-1,1]. */
const dA = (x, y, ox, oy) => sampleF(FA, NRES, ox + x * 0.30, oy + y * 0.30);
/** Fine grit, 0..1. */
const dB = (x, y, ox, oy) => sampleF(FB, NRES, ox + x * 0.32, oy + y * 0.32);

/** Signed angular difference, no trig. Keeps the spine loops cheap. */
const adiff = (a, b) => { const d = a - b; return d - TAU * Math.round(d / TAU); };

// ---- angular tables: tabulating sin(k*a) beats 3-5 sin calls per pixel ------
const ANG_N = 2048;
const ANG_K = ANG_N / TAU;
function angTable(fn) {
  const t = new Float32Array(ANG_N + 2);
  for (let i = 0; i <= ANG_N + 1; i++) t[i] = fn(-Math.PI + (i / ANG_N) * TAU);
  return t;
}
const angAt = (t, a) => t[((a + Math.PI) * ANG_K) | 0];

// ---- per-feature constants, hoisted out of the pixel loops -----------------
// Flat typed arrays with a fixed stride: calling hash2 17 times per pixel
// inside the thorn spine loop was the single most expensive thing in the kit.
let STAR_B = null;    // stride 4: a0, len, curl, wid
let THORN_S = null;   // stride 3: a0, len, thick
let PETAL_C = null;   // stride 3: a0, reach, bright
let PETAL_O = null;   // stride 2: cx, cy
let BOKEH_B = null;   // stride 3: cos, sin, push
let RING_R = null, RING_G = null, RING_S = null;
let SHOCK_R = null, SHOCK_G = null, SHOCK_S = null;
let HALO_R = null, HALO_G = null;
let PETAL_M = null, PETAL_RG = null;
// LEAF is tabulated in BOTH directions - along the blade (stride 1 per table)
// and across it - so the pixel loop has no transcendental at all. See pLeaf.
let LEAF_WU = null, LEAF_WD = null, LEAF_S = null, LEAF_A = null, LEAF_X = null;

function buildTables() {
  if (FA) return;
  FA = mkField(NRES, 5, 4);
  FB = mkField(NRES, 13, 3);

  STAR_B = new Float64Array(7 * 4);
  for (let k = 0; k < 7; k++) {
    const h1 = hash2(k + 1, 91), h2 = hash2(k + 1, 173), h3 = hash2(k + 1, 251);
    STAR_B[k * 4] = (k / 7) * TAU + (h1 - 0.5) * 0.62;      // irregular spacing
    STAR_B[k * 4 + 1] = 0.32 + Math.pow(h2, 1.5) * 0.66;    // very unequal reach
    STAR_B[k * 4 + 2] = 0.20 * (h1 - 0.3);                  // blade curvature
    STAR_B[k * 4 + 3] = 0.011 + h3 * 0.026;
  }

  THORN_S = new Float64Array(17 * 3);
  for (let k = 0; k < 17; k++) {
    const h1 = hash2(k + 3, 611), h2 = hash2(k + 3, 727), h3 = hash2(k + 3, 883);
    THORN_S[k * 3] = (k / 17) * TAU + (h1 - 0.5) * (TAU / 17) * 0.95;  // uneven
    THORN_S[k * 3 + 1] = 0.54 + Math.pow(h2, 1.4) * 0.42;              // uneven reach
    THORN_S[k * 3 + 2] = 0.058 + h3 * 0.050;                           // base thickness
  }

  PETAL_C = new Float64Array(8 * 3);
  for (let k = 0; k < 8; k++) {
    const h1 = hash2(k + 5, 313), h2 = hash2(k + 5, 331), h3 = hash2(k + 5, 347);
    PETAL_C[k * 3] = (k / 8) * TAU + (h1 - 0.5) * 0.46;
    PETAL_C[k * 3 + 1] = 0.72 + h2 * 0.30;        // some canals stop short
    PETAL_C[k * 3 + 2] = 0.55 + h3 * 0.45;        // and some are fainter
  }
  PETAL_O = new Float64Array(4 * 2);
  for (let k = 0; k < 4; k++) {
    const oa = (k / 4) * TAU + 0.6, rr = 0.22 + hash2(k + 9, 401) * 0.08;
    PETAL_O[k * 2] = Math.cos(oa) * rr; PETAL_O[k * 2 + 1] = Math.sin(oa) * rr;
  }

  BOKEH_B = new Float64Array(6 * 3);
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * TAU + 0.2;
    BOKEH_B[i * 3] = Math.cos(ang); BOKEH_B[i * 3 + 1] = Math.sin(ang);
    BOKEH_B[i * 3 + 2] = 1 + (hash2(i + 1, 401) - 0.5) * 0.07;  // uneven iris
  }

  // Integer harmonics only: sin(k*atan2) is continuous across the branch cut
  // for integer k and discontinuous otherwise, and that seam is a visible slice.
  RING_R = angTable((a) => 0.76 + 0.016 * Math.sin(a * 3 + 1.1)
                                + 0.010 * Math.sin(a * 5 - 0.4)
                                + 0.006 * Math.sin(a * 11 + 2.7));
  RING_G = angTable((a) => 0.60 + 0.40 * (0.5 + 0.5 * Math.sin(a * 2 - 0.9))
                                      * (0.62 + 0.38 * Math.sin(a * 7 + 1.7)));
  RING_S = angTable((a) => Math.sin(a * 23 + 0.6) * Math.sin(a * 4 - 1.2));

  SHOCK_R = angTable((a) => 0.72 + 0.030 * Math.sin(a * 2 + 0.5)
                                 + 0.018 * Math.sin(a * 5 + 2.2)
                                 + 0.011 * Math.sin(a * 9 - 1.4));
  SHOCK_G = angTable((a) => 0.46 + 0.54 * Math.pow(0.5 + 0.5 * Math.sin(a * 3 + 0.8), 0.7));
  SHOCK_S = angTable((a) => Math.sin(a * 13 + 1.9));

  HALO_R = angTable((a) => 0.80 + 0.016 * Math.sin(a * 3 + 0.7)
                                + 0.010 * Math.sin(a * 7 - 2.1));
  HALO_G = angTable((a) => 0.86 + 0.14 * Math.sin(a * 5 + 1.3));

  // Scalloped bell margin. Random per-harmonic phases make the lobes uneven,
  // and the single-harmonic term is what makes one side of the bell larger.
  PETAL_M = angTable((a) => 0.78 + 0.052 * Math.sin(a + 1.9)
                                 + 0.042 * Math.sin(a * 9 + 0.4)
                                 + 0.024 * Math.sin(a * 5 - 2.3)
                                 + 0.016 * Math.sin(a * 13 + 1.1));
  PETAL_RG = angTable((a) => 0.66 + 0.34 * (0.5 + 0.5 * Math.sin(a * 4 - 1.5)));

  buildLeaf();
}

// ------------------------------------------------------------------- LEAF ---
// The blade lives in two 1-D tables and is assembled per pixel with no
// transcendental: one set indexed along the length (t, from nx), one indexed
// across it (|q|, the signed distance from the medial axis over the local
// half-width). Every pow/sin/sqrt/exp below is paid 1024 or 512 times at boot
// instead of 65536 times in the pixel loop, so pLeaf itself is two table reads,
// a subtract and a divide.
//
// Boot cost, measured by running buildSpriteArray 31 times against a no-op GL
// stub in node (the browser's own buildAll timing has +-150ms of noise, which
// is larger than a whole layer, so it cannot price one): +0.2ms on the min and
// +3.4ms on the median of a ~265ms sprite build. Most of even that is the mip
// chain, which every layer pays alike - the paint loop is under a millisecond.
const LEAF_N = 1024;                  // samples along the blade
const LEAF_XN = 512;                  // samples across it
const LEAF_QMAX = 1.85;               // |q| at which the soft skirt is exactly 0
const LEAF_TK = LEAF_N / 2;           // nx in [-1,1] -> along-table index
const LEAF_XK = LEAF_XN / LEAF_QMAX;
// Half-width at the widest point, in ny units, so the painted thickness is this
// times the FULL quad height (the sprite quad maps [-1,1] onto its whole size).
// SHARD's peak is 0.126, which is why blades made from it read as twigs.
// Measured on seed 7 `fast` and `deep` at 3x: 0.24 is unambiguously a leaf and
// no longer a barb, 0.30 is the broader read the request asked for and is what
// is here. It is bounded above by render.js, which offsets the lit face 0.13 of
// the quad off the medial axis: at 0.30 the lit strip still overlaps the dark
// blade and reads as a rim light on it, and past ~0.34 it separates and draws a
// second, parallel blade. Exposure is nearly insensitive to this - the whole
// twelve-frame gate moves by at most 0.3pp of shadow between 0.126 and 0.30.
const LEAF_HW = 0.30;

function buildLeaf() {
  LEAF_WU = new Float32Array(LEAF_N + 2);
  LEAF_WD = new Float32Array(LEAF_N + 2);
  LEAF_S = new Float32Array(LEAF_N + 2);
  LEAF_A = new Float32Array(LEAF_N + 2);
  for (let i = 0; i <= LEAF_N + 1; i++) {
    const t = clamp01(i / LEAF_N);
    // Ramp off the stipe. There is a real tension in this number and it is worth
    // knowing about: render.js builds one blade from TWO of these, the second
    // starting at 0.86 of the first's length and rotated 0.30-0.80 rad away, so
    // the first piece's cap and the second's base overlap over only ~10% of
    // either quad. A long ramp meets the cap where both are narrow and pinches
    // the elbow; a short one leaves each piece a round-ended rod. The first cut
    // used 0.10, and under ?debugLayers=1 every blade read as a bent BONE -
    // constant width, rounded at both ends. 0.16 plus the taper below is what
    // turns each piece back into a leaf; the residual pinch at the elbow is
    // ~40% of full width over about 4px of a 60px blade, and reads as a fold.
    const ramp = smoothstep(t / 0.16);
    // The tip. sqrt is the whole point: the half-width falls with INFINITE
    // slope at the apex, which is what "rounded" means geometrically. Any
    // exponent >= 1 here is a point, and a point is a thorn however it is
    // oriented - that is the defect this layer exists to remove. 0.155 of the
    // length makes the cap as long as the blade is half-thick at the widths
    // render.js draws, i.e. very close to a true semicircle.
    const cap = Math.sqrt(clamp01((1 - t) / 0.155));
    // Half the width is gone by the tip. The brief was "near-constant width
    // over most of its length", and 0.24*t^1.9 delivered that literally - and
    // literally was wrong, because render.js's second piece is drawn at 0.62 of
    // the first's height, so two constant-width pieces make a rod that STEPS
    // rather than a blade that tapers. 0.42*t^1.5 falls slowly enough to still
    // be a strap through the first half and hands off to the second piece at
    // roughly the width that piece starts at.
    const strap = 1 - 0.42 * Math.pow(t, 1.5);
    const w = LEAF_HW * ramp * cap * strap;
    // Undulating margin, decorrelated per side. Two reasons, both load-bearing.
    // (1) A near-constant-width strap has two PARALLEL STRAIGHT edges, which is
    // the stretched-quad trap wearing a different hat - the medial axis stops
    // being the only straight line in the shape. (2) Because the two margins
    // are independent, the medial axis is w*(ru-rd)/2 off the spine and is
    // therefore not a segment either. Real blades have crinkled margins, so
    // this is also just what a blade looks like.
    const ru = sampleF(FA, NRES, 0.19 + t * 1.15, 0.44);
    const rd = sampleF(FA, NRES, 0.63 + t * 1.15, 0.81);
    LEAF_WU[i] = Math.max(MIN_SOFT, w * (0.86 + 0.30 * ru));
    LEAF_WD[i] = Math.max(MIN_SOFT, w * (0.86 + 0.30 * rd));
    // Spine: a gentle S. Zero at the base so the blade leaves the stipe along
    // the quad's axis (render.js sets rot from the local tangent), then a
    // cantilever sweep. render.js flips the blade's side but never mirrors the
    // sprite, so a fixed-sign bow ADDS to the fold on one side and opposes it
    // on the other - half the blades curve, half are S-shaped, for free.
    LEAF_S[i] = 0.26 * Math.pow(t, 1.7) - 0.06 * Math.sin(t * 3.4);
    // Amplitude follows the width, so the cap ends in nothing rather than in a
    // MIN_SOFT-wide bright hair - which would be a point again. The noise term
    // is a slight density drift along the length: a blade is not a slab. Capped
    // at 1.0 so it never clips against the cross-section's own peak.
    const dens = 0.86 + 0.14 * sampleF(FB, NRES, 0.31 + t * 0.9, 0.12);
    LEAF_A[i] = clamp01(w / (LEAF_HW * 0.30)) * Math.min(1, dens);
  }

  // Across the blade: a plateau with soft shoulders plus a faint spill, i.e.
  // the thing AGENTS.md says a ribbon can never draw - opaque through the
  // middle AND exactly zero inside its own quad.
  //
  // NO MIDRIB, and that is a measurement rather than an omission. A real blade
  // has one, so it was built (exp(-(q/0.22)^2)*0.20, body dropped to 0.66 to
  // make room) and both versions were rendered at true size through the real
  // mip chain. At 168px the rib is obvious. At 48px - the top of the range
  // render.js actually draws - the two are indistinguishable, and at 24px they
  // are identical. It is 1-2px of a blade that is 11-16px thick, so the mip
  // chain has averaged it away before it can be seen, and paying for it means
  // a flatter body and a softer silhouette everywhere. Reverted.
  LEAF_X = new Float32Array(LEAF_XN + 2);
  for (let i = 0; i <= LEAF_XN + 1; i++) {
    const q = (i / LEAF_XN) * LEAF_QMAX;
    const body = 1 - smoothstep((q - 0.58) / 0.44);
    const skirt = Math.exp(-Math.pow(q / 0.86, 2)) * 0.17;
    // The skirt is still ~8e-4 at QMAX, and a hard cut there is a step from
    // stored byte 10 to 0 - the same mistake ANAMORPH's note describes. Window
    // it to exactly zero instead.
    const shut = 1 - smoothstep((q - 1.42) / 0.43);
    LEAF_X[i] = clamp01((body * 0.83 + skirt) * shut);
  }
}

// ---------------------------------------------------------------- profiles ---

/**
 * CORE: near-delta hot point. Draw small, with gain > 1.
 * The skirt is compressed to r<0.67 rather than running to the tile edge, for
 * two reasons: it leaves a dark margin so every mip level still reads as a
 * round dot instead of a filled tile, and it keeps the hot region compact when
 * the scene multiplies this by 10-30x for the HDR core contract - a broad skirt
 * just blows out into a featureless white disc at that gain.
 */
const pCore = (r) => {
  if (r >= 1) return 0;
  const c = Math.exp(-r * r * 105);
  const knee = Math.pow(Math.max(0, 1 - r * 1.5), 7) * 0.34;
  return clamp01(c + knee);
};

/** GLOW: the workhorse. Two-lobe - tight core + broad halo, as a real point
 *  emitter reads through a lens. Unchanged; 11 callers are balanced to it. */
const pGlow = (r) => {
  if (r >= 1) return 0;
  const c = Math.exp(-r * r * 26);
  const halo = Math.pow(1 - r, 3.4) * 0.55;
  const veil = Math.pow(1 - r, 1.35) * 0.09;
  return clamp01(c + halo + veil);
};

/** VOLUME: a lit ball of fog. Flat shoulder, defined rim, soft spill. */
const pVolume = (r) => {
  if (r >= 1) return 0;
  const R = 0.74;
  const q = clamp01(r / R);
  const chord = Math.pow(1 - q * q, 0.55);            // flattened shoulder
  const knee = 1 - smoothstep((q - 0.9) / 0.2);       // takes the sting off the rim
  const spill = Math.pow(1 - clamp01(r), 3.0) * 0.24; // light leaking past it
  return clamp01(chord * knee * 0.94 + spill);
};

/** VEIL: wide, faint, structureless outer scatter. No core by design. */
const pVeil = (r) => {
  if (r >= 1) return 0;
  const k = 1 - r;
  return clamp01(Math.pow(k, 2.1) * 0.40 + Math.pow(k, 1.05) * 0.11);
};

/** SPARK: small hot mote with two unequal blades. Lives at 6-40px, so it is
 *  crude on purpose - anything finer is grey mush by the time it is drawn. */
function pSpark(nx, ny, r) {
  if (r >= 1) return 0;
  const c = Math.exp(-r * r * 42);
  const ax = Math.abs(nx), ay = Math.abs(ny);
  const long = Math.exp(-(ny * ny) / 0.0034) * Math.pow(Math.max(0, 1 - ax), 2.6) * 0.55;
  const shortB = Math.exp(-(nx * nx) / 0.0062) * Math.pow(Math.max(0, 1 - ay), 3.4) * 0.24;
  // halo kept inside r<0.77 so the tile has a dark margin at every mip level
  const halo = Math.pow(Math.max(0, 1 - r * 1.3), 4.0) * 0.28;
  return clamp01(c + long + shortB + halo);
}

/** PLANKTON: drawn at 6-30px. Deliberately almost featureless - a hot nucleus,
 *  one soft halo, one off-centre glint for a hint of volume. The old diatom
 *  shell and six cilia turned to a grey ring-with-a-hole below 16px. */
function pPlankton(nx, ny, r) {
  if (r >= 1) return 0;
  const nucleus = Math.exp(-r * r * 28);
  // compressed to r<0.74: a dark margin is what keeps this a dot rather than a
  // filled square once the mip chain takes over below ~16px
  const halo = Math.pow(Math.max(0, 1 - r * 1.35), 3.0) * 0.46;
  const dx = nx - 0.15, dy = ny + 0.13;
  const glint = Math.exp(-(dx * dx + dy * dy) * 20) * 0.22;
  return clamp01(nucleus + halo + glint);
}

/** RING: expanding shock front. Hard outside, thin bright edge, wake inward. */
function pRing(r, a) {
  if (r >= 1) return 0;
  const R = angAt(RING_R, a), gain = angAt(RING_G, a);
  if (r > R) {
    // Ahead of the front there is near-vacuum - only a hair of forward scatter.
    // That asymmetry is the whole reason it stops reading as a donut.
    const t = (r - R) / 0.030;
    return clamp01(Math.exp(-t * t) * 0.26 * gain);
  }
  const e = (r - R) / 0.026;
  const edge = Math.exp(-e * e);
  const wake = Math.pow(clamp01((r - (R - 0.50)) / 0.50), 2.2) * 0.62;
  const spokes = 1 + 0.20 * angAt(RING_S, a)
                     * Math.pow(clamp01((r - (R - 0.42)) / 0.42), 2);
  return clamp01((edge + wake * spokes) * gain);
}

/** SHOCK: the violent one. Thicker front, deeper wake, coarse striations. */
function pShock(r, a) {
  if (r >= 1) return 0;
  const R = angAt(SHOCK_R, a), gain = angAt(SHOCK_G, a);
  if (r > R) {
    const t = (r - R) / 0.042;
    return clamp01(Math.exp(-t * t) * 0.34 * gain);
  }
  const e = (r - R) / 0.040;
  const edge = Math.exp(-e * e) * 1.05;
  const wake = Math.pow(clamp01((r - (R - 0.66)) / 0.66), 1.8) * 0.55;
  const stri = 1 + 0.30 * angAt(SHOCK_S, a) * Math.pow(clamp01(r / R), 1.4);
  const flash = Math.exp(-r * r * 14) * 0.24;
  return clamp01((edge + wake * stri) * gain + flash);
}

/** HALO: thin optical rim with a faint interior so it survives at 4px. */
function pHalo(r, a) {
  if (r >= 1) return 0;
  const R = angAt(HALO_R, a);
  const t = (r - R) / 0.042;
  const line = Math.exp(-t * t) * angAt(HALO_G, a);
  const bloom = Math.exp(-Math.pow((r - R) / 0.15, 2)) * 0.15;
  const inner = Math.pow(clamp01(1 - r), 4) * 0.10;
  return clamp01((line + bloom + inner) * (1 - smoothstep((r - 0.93) / 0.07)));
}

/**
 * STAR: an asymmetric aperture flare. Seven blades at irregular angles with
 * unequal lengths and widths and a slight curl. A symmetric 6-point cross is
 * the tell of a stock asset, so this deliberately has no mirror symmetry: each
 * blade is one-sided, with no twin at angle+pi. The thin bright spine inside
 * each blade is high-contrast on purpose - it is the structure the post chain's
 * chromatic aberration turns into a spectral edge.
 */
function pStar(nx, ny, r, a) {
  if (r >= 1) return 0;
  let v = pGlow(r) * 0.44 + pVeil(r) * 0.20;
  for (let k = 0; k < 7; k++) {
    const len = STAR_B[k * 4 + 1];
    if (r > len) continue;
    const ang = STAR_B[k * 4] + STAR_B[k * 4 + 2] * r;   // the blade bends
    const perp = adiff(a, ang) * r;
    const t = r / len;
    const hw = Math.max(MIN_SOFT, STAR_B[k * 4 + 3] * (0.32 + 0.68 * (1 - t)));
    const q = perp / hw;
    if (q * q > 12) continue;
    const taper = Math.pow(1 - t, 1.7);
    v += (Math.exp(-q * q) * 0.88 + Math.exp(-(q * q) / 30) * 0.15) * taper;
  }
  return clamp01(v * (1 - smoothstep((r - 0.95) / 0.05)));
}

/** STREAK: tight anamorphic flare. Callers stretch it 4:1 to 13:1 already. */
function pStreak(nx, ny) {
  const u = Math.abs(nx);
  const fall = Math.pow(Math.max(0, 1 - u), 2.0);
  // striations along the length - a cylindrical element is never smooth
  const stri = 0.76 + 0.24 * (0.5 + 0.5 * Math.sin(nx * 27 + 0.7))
                          * (0.5 + 0.5 * Math.sin(nx * 61 - 2.0));
  const core = Math.exp(-(ny * ny) / (0.0026 + 0.011 * u * u)) * fall * stri;
  const body = Math.exp(-(ny * ny) / 0.030) * Math.pow(Math.max(0, 1 - u), 1.3) * 0.28;
  const veil = Math.exp(-(ny * ny) / 0.17) * Math.pow(Math.max(0, 1 - u), 0.9) * 0.07;
  // a thin lip above and below the core: fine structure for CA to tint
  const lip = Math.exp(-Math.pow((Math.abs(ny) - 0.055) / 0.018, 2)) * fall * 0.13;
  return clamp01(core + body + veil + lip);
}

/** ANAMORPH: wide, soft, long. For big lights where STREAK reads as a scratch. */
function pAnamorph(nx, ny) {
  const u = Math.abs(nx);
  const fall = Math.pow(Math.max(0, 1 - u), 1.5);
  const stri = 0.82 + 0.18 * (0.5 + 0.5 * Math.sin(nx * 15 - 1.1));
  const core = Math.exp(-(ny * ny) / (0.014 + 0.030 * u * u)) * fall * stri * 0.86;
  const body = Math.exp(-(ny * ny) / 0.085) * Math.pow(Math.max(0, 1 - u), 1.0) * 0.30;
  const veil = Math.exp(-(ny * ny) / 0.40) * Math.pow(Math.max(0, 1 - u), 0.7) * 0.10;
  // the wide veil is still ~0.008 at the top and bottom edges, and CLAMP_TO_EDGE
  // would smear that along the whole border - so close it off explicitly
  return clamp01((core + body + veil) * (1 - smoothstep((Math.abs(ny) - 0.84) / 0.16)));
}

/**
 * THORN: sea urchin, drawn twice by render.js - once dark into the occluder
 * pass, once lit on top - so the mask has to work as a silhouette AND as light.
 * 17 spines at irregular angles, each with its own length and thickness, thick
 * at the base and tapering to a point, all sharing a slight clockwise curl.
 * The body carries growth rings, ambulacral rows and fibre; the old profile was
 * a constant plateau, which is why it read as a sheriff's badge.
 */
function pThorn(nx, ny, r, a) {
  if (r >= 1) return 0;
  let sp = 0;
  for (let k = 0; k < 17; k++) {
    const len = THORN_S[k * 3 + 1];
    if (r > len) continue;
    const ang = THORN_S[k * 3] + 0.22 * r;              // shared curl
    const perp = adiff(a, ang) * r;
    const t = r / len;
    const hw = Math.max(MIN_SOFT, THORN_S[k * 3 + 2] * Math.pow(1 - t, 0.85));
    const q = perp / hw;
    if (q * q > 10) continue;
    // bright where the body lights the spine, with a small glint at the tip
    const along = (1 - t) * (0.45 + 0.55 * (1 - t))
                + Math.exp(-Math.pow((t - 0.93) / 0.08, 2)) * 0.42;
    const v = Math.exp(-q * q) * along;
    if (v > sp) sp = v;   // max, not sum: overlapping spines must not blow out
  }
  // Body radius: the old flat profile massed at 0.42, and dropping to 0.31 made
  // urchins read as small spiky balls instead of the frame's main threat.
  const BR = 0.40;
  const inb = 1 - smoothstep((r - BR) / 0.05);
  // pattern fades out before the rim, so there are no tick marks around a dial
  const pat = clamp01(1 - r / BR);
  const rings = 0.5 + 0.5 * Math.sin(r * 40 - 0.6);
  const rows = 0.5 + 0.5 * Math.sin(a * 7 + r * 9);
  const fib = dA(nx, ny, 0.21, 0.63);
  const body = (0.52 + 0.10 * rings * rows * pat + 0.20 * fib) * inb;
  const rim = Math.exp(-Math.pow((r - BR) / 0.042, 2)) * 0.92;   // the hot rim
  const inner = Math.exp(-r * r * 8) * 0.16;
  return clamp01(sp * 0.90 + body + rim + inner);
}

/**
 * PETAL: a jellyfish bell, also used for the anchor petals. A translucent dome:
 * brightest at the margin and along the radial canals, dimmer across the open
 * membrane, with a vertical gradient so it reads as a dome rather than a disc.
 * The margin is scalloped by four harmonics with unrelated phases so the lobes
 * are uneven, and the canals curve and vary in reach. Fibre noise keeps the
 * membrane off looking like vector art; the old profile was a flat five-point
 * starfish with a constant interior.
 */
function pPetal(nx, ny) {
  // squash and offset into a dome - off-centre, so it is not symmetric
  const x = nx * 0.94, y = ny * 1.06 - 0.03;
  const rr = Math.sqrt(x * x + y * y);
  if (rr >= 1) return 0;
  const aa = Math.atan2(y, x);
  const marg = angAt(PETAL_M, aa);
  const q = rr / marg;
  if (q >= 1.15) return 0;
  const inside = 1 - smoothstep((q - 0.96) / 0.11);
  let canal = 0;
  for (let k = 0; k < 8; k++) {
    const reach = PETAL_C[k * 3 + 1];
    if (q > reach) continue;
    const ca = PETAL_C[k * 3] + 0.26 * q;              // canals curve outward
    const hw = Math.max(MIN_SOFT, 0.020 * (0.4 + 0.6 * q));
    const d = adiff(aa, ca) * rr / hw;
    if (d * d > 10) continue;
    const v = Math.exp(-d * d) * smoothstep((q - 0.16) / 0.30) * PETAL_C[k * 3 + 2];
    if (v > canal) canal = v;
  }
  const membrane = 0.19 + 0.17 * Math.pow(q, 2.2);                    // edge-bright
  const ring = Math.exp(-Math.pow((q - 0.92) / 0.055, 2)) * angAt(PETAL_RG, aa);
  const dome = 0.13 * clamp01(0.5 + y / (marg * 1.4));                // reads 3-D
  const fib = (dA(x, y, 0.72, 0.31) - 0.5) * 0.14;
  // gonads: four soft masses so the middle of the bell is not empty
  let organs = 0;
  for (let k = 0; k < 4; k++) {
    const dx = x - PETAL_O[k * 2], dy = y - PETAL_O[k * 2 + 1];
    organs += Math.exp(-(dx * dx + dy * dy) * 32) * 0.22;
  }
  const apex = Math.exp(-rr * rr * 7) * 0.13;
  return clamp01((membrane + canal * 0.42 + ring + organs + apex + dome + fib) * inside);
}

/** BLOB: irregular soft mass - the jellyfish occluder, so it needs a real
 *  silhouette. Several incommensurate harmonics, because the single sin(3a) it
 *  used to have made a triangle. */
function pBlob(nx, ny, r, a) {
  if (r >= 1) return 0;
  const wob = 1 + 0.075 * Math.sin(a * 2 + 0.9) + 0.055 * Math.sin(a * 5 - 1.7)
            + 0.032 * Math.sin(a * 9 + 2.4);
  const q = r / (0.84 * wob);
  if (q >= 1.15) return 0;
  const soft = Math.pow(Math.max(0, 1 - q), 1.7);
  const dens = dA(nx, ny, 0.44, 0.18);
  return clamp01(soft * (0.88 + 0.24 * dens) + Math.exp(-q * q * 4) * 0.22);
}

/** SMOKE: a torn puff, 40-420px. The silhouette is eroded by the COARSE field,
 *  so the edge is lumpy rather than the spiky splat a fine field gives. */
function pSmoke(nx, ny, r) {
  if (r >= 1) return 0;
  const n1 = dA(nx, ny, 0.13, 0.77);
  const n2 = dB(nx, ny, 0.61, 0.29);
  const ridged = 1 - Math.abs(n1 * 2 - 1);
  const dens = clamp01(0.30 * ridged + 0.56 * n1 + 0.22 * n2 - 0.14);
  const mask = clamp01((1 - r) * 1.34 - (1 - n1) * 0.52);
  return clamp01(Math.pow(mask, 1.4) * (0.30 + dens * 1.30));
}

/** FILAMENT: one hair - long, thin, gently S-curved, tapering to nothing at
 *  both ends. Draw it long and thin (8:1) for tentacles and frayed strands. */
function pFilament(nx, ny) {
  const t = (nx + 1) * 0.5;
  if (t <= 0 || t >= 1) return 0;
  const spine = 0.17 * Math.sin(t * 5.4 + 0.6) + 0.055 * Math.sin(t * 11.0);
  const yy = ny - spine;
  const env = Math.pow(Math.sin(t * Math.PI), 0.7);
  // thickness beads slightly along the length so it is not an extruded tube
  const bead = 0.80 + 0.40 * dB(nx, 0, 0.37, 0.52);
  const hw = Math.max(MIN_SOFT, 0.013 * env * bead);
  const q = yy / hw;
  const core = q * q > 12 ? 0 : Math.exp(-q * q) * env;
  const halo = Math.exp(-Math.pow(yy / (hw * 7), 2)) * 0.16 * env;
  return clamp01(core + halo);
}

/**
 * LEAF: a kelp blade. Broad, near-constant width over most of its length, a
 * rounded tip, soft edges that reach zero well inside the quad. Long axis on
 * X, base at nx=-1, tip at nx=+1 - the same convention as SHARD and FILAMENT,
 * because render.js draws these with the quad's WIDTH along the blade.
 *
 * Painted extent, computed over the tables: the mask is exactly zero outside
 * |ny| = 0.646, and the silhouette (where it is still above ~0.05) inside
 * |ny| = 0.414. So better than a third of the quad's height is dark at every
 * mip level, which is what keeps this a blade rather than a filled tile once
 * the mip chain takes over below ~12px - the same reason CORE, SPARK and
 * PLANKTON compress their skirts.
 */
function pLeaf(nx, ny) {
  const j = ((nx + 1) * LEAF_TK) | 0;
  if (j < 0 || j > LEAF_N) return 0;
  const a = LEAF_A[j];
  if (a <= 0) return 0;
  const d = ny - LEAF_S[j];
  // The two margins are independent, so which one applies depends on the SIGN
  // of the offset. The value at d=0 is the same from both sides, so this is
  // continuous - only the edges differ, which is the entire intent.
  const hw = d >= 0 ? LEAF_WU[j] : LEAF_WD[j];
  const q = (d < 0 ? -d : d) / hw;
  if (q >= LEAF_QMAX) return 0;
  return LEAF_X[(q * LEAF_XK) | 0] * a;
}

/** WISP: comma-shaped smear for motion trails - thin curved tail, fat head at
 *  +x so callers can point it along velocity with rot. Currently unused. */
function pWisp(nx, ny, r) {
  if (r >= 1) return 0;
  const t = clamp01((nx + 0.88) / 1.64);
  const arc = 0.24 * Math.sin(t * 2.2) - 0.05;
  const yy = ny - arc;
  const w = Math.max(MIN_SOFT, 0.018 + 0.26 * Math.pow(t, 1.6));
  const body = Math.exp(-(yy * yy) / (w * w)) * (0.22 + 0.78 * Math.pow(t, 1.5));
  const dx = nx - 0.30, dy = ny - (0.24 * Math.sin(2.2) - 0.05);
  const head = Math.exp(-(dx * dx + dy * dy) * 10) * 0.48;
  const fib = 0.84 + 0.32 * dA(nx, ny, 0.88, 0.07);
  return clamp01((body * fib + head) * (1 - smoothstep((r - 0.86) / 0.14)));
}

/** SHARD: long thin sliver - light shafts, rock chips. Asymmetric taper: blunt
 *  at one end, pointed at the other. Currently unused. */
function pShard(nx, ny) {
  const t = (nx + 1) * 0.5;
  if (t <= 0 || t >= 1) return 0;
  const env = Math.pow(t, 0.55) * Math.pow(1 - t, 1.9) * 3.1;
  const hw = Math.max(MIN_SOFT, env * 0.15);
  const core = Math.exp(-Math.pow(ny / hw, 2));
  const soft = Math.exp(-Math.pow(ny / (hw * 4.5), 2)) * 0.22;
  return clamp01((core * 0.95 + soft) * clamp01(env * 1.6));
}

/** BOKEH: out-of-focus aperture. Uneven iris blades, edge ringing, and onion
 *  diffraction rings that follow the true radius - keying them to the polygon
 *  distance made a nest of concentric hexagons. Currently unused. */
function pBokeh(nx, ny, r) {
  let d = -1e9;
  for (let i = 0; i < 6; i++) {
    const v = (nx * BOKEH_B[i * 3] + ny * BOKEH_B[i * 3 + 1]) / BOKEH_B[i * 3 + 2];
    if (v > d) d = v;
  }
  d /= 0.8660254;   // cos(pi/6)
  const R = 0.70;
  const edge = 1 - smoothstep((d - R) / 0.05);
  const rim = Math.exp(-Math.pow((d - R * 0.965) / 0.042, 2)) * 0.60;
  const onion = 0.05 * Math.sin(r * 42) * clamp01(r / R);
  const body = 0.34 + 0.16 * Math.pow(clamp01(d / R), 2.4) + onion;
  const grit = (dB(nx, ny, 0.25, 0.66) - 0.5) * 0.08;
  return clamp01((body + rim + grit) * edge);
}

/** CAUSTIC_SPOT: anisotropic ridged web rather than isotropic static.
 *  Currently unused - background.js does its caustics in-shader. */
function pCaustic(nx, ny, r) {
  if (r >= 1) return 0;
  const n1 = dA(nx * 1.6, ny * 0.9, 0.34, 0.81);
  const n2 = dB(nx * 1.1, ny * 0.7, 0.09, 0.44);
  const rid = 1 - Math.abs(n1 * 2 - 1);
  const rid2 = 1 - Math.abs(n2 * 2 - 1);
  const web = Math.pow(rid, 3.0) * 0.95 + Math.pow(rid2, 5.0) * 0.55;
  return clamp01(web * Math.pow(1 - r, 1.5) * 1.9);
}

// ------------------------------------------------------------------- build ---
export function buildSpriteArray(gl) {
  buildTables();
  const tex = textureArray(gl, { width: SPRITE_SIZE, height: SPRITE_SIZE, layers: SPRITE_LAYERS });
  const P = SPRITE_SIZE;
  const emit = (layer, bytes) => {
    uploadLayer(gl, tex, layer, P, P, bytes);
    uploadMips(gl, tex, layer, P, bytes);   // linear-space chain; see uploadMips
  };
  const put = (layer, fn, ang = false) => emit(layer, paint(P, fn, ang));
  const putR = (layer, fn) => emit(layer, paintRadial(P, fn));

  putR(S.GLOW, pGlow);
  putR(S.CORE, pCore);
  putR(S.VEIL, pVeil);
  putR(S.VOLUME, pVolume);

  put(S.SPARK, (x, y, r) => pSpark(x, y, r));
  put(S.RING, (x, y, r, a) => pRing(r, a), true);
  put(S.STREAK, (x, y) => pStreak(x, y));
  put(S.BOKEH, (x, y, r) => pBokeh(x, y, r));
  put(S.PLANKTON, (x, y, r) => pPlankton(x, y, r));
  put(S.BLOB, (x, y, r, a) => pBlob(x, y, r, a), true);
  put(S.STAR, (x, y, r, a) => pStar(x, y, r, a), true);
  put(S.WISP, (x, y, r) => pWisp(x, y, r));
  put(S.CAUSTIC_SPOT, (x, y, r) => pCaustic(x, y, r));
  put(S.HALO, (x, y, r, a) => pHalo(r, a), true);
  put(S.SHARD, (x, y) => pShard(x, y));
  put(S.SMOKE, (x, y, r) => pSmoke(x, y, r));
  put(S.THORN, (x, y, r, a) => pThorn(x, y, r, a), true);
  put(S.PETAL, (x, y) => pPetal(x, y));
  put(S.SHOCK, (x, y, r, a) => pShock(r, a), true);
  put(S.ANAMORPH, (x, y) => pAnamorph(x, y));
  put(S.FILAMENT, (x, y) => pFilament(x, y));
  put(S.LEAF, (x, y) => pLeaf(x, y));

  // No generateMipmap: uploadMips has already written every level, correctly.
  return tex;
}

/**
 * Tiling noise. Four genuinely different bands, not four frequencies of one
 * field, so a shader can pick a scale instead of getting the same lumps at
 * every octave. All periodic on the integer lattice, so it is exactly seamless
 * under REPEAT.
 *
 *   .r  broad drift, 3 cells + 4 octaves   - fog density, slow warp, profiles
 *   .g  mid detail, 8 cells + 3 octaves    - silt, grain, break-up
 *   .b  ridged, 6 cells + 3 octaves        - veins, creases, caustic filaments
 *   .a  broad and decorrelated from .r     - a second independent flow field
 */
export function buildNoiseTexture(gl, size = 256) {
  const px = new Uint8Array(size * size * 4);
  // .r and .a are low frequency, so they are built on a half-res grid and
  // bilerped - visually identical, and a quarter of the hashing.
  const half = size >> 1;
  const fr = mkField(half, 3, 4);
  const fa = mkField(half, 2, 3);
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size, i = (y * size + x) * 4;
      px[i] = Math.round(clamp01(sampleF(fr, half, u, v)) * 255);
      px[i + 1] = Math.round(clamp01(pfbm(u, v, 8, 3)) * 255);
      px[i + 2] = Math.round(clamp01(pridge(u, v, 6, 3)) * 255);
      px[i + 3] = Math.round(clamp01(sampleF(fa, half, u + 0.37, v + 0.71)) * 255);
    }
  }
  return texture2D(gl, { width: size, height: size, data: px, wrap: gl.REPEAT, mips: true });
}

/**
 * Lens dirt, multiplied into the bloom by postfx (bloom *= 1 + dirt*~1.0).
 *
 * Two things make a dirt map register. First SCALE: the old map was a confetti
 * of 1-16px specks in a 512 tile, which lands at a couple of screen pixels and
 * vanishes. Second CLUMPING: real glass has filthy patches and clean patches,
 * so everything here is weighted by a low-frequency grease field and the mean
 * stays low - a uniformly grubby map just reads as a flat bloom boost.
 *
 * postfx samples this at roughly one tile down the screen but ~1.6 tiles across
 * at 16:9, so it must stay seamless. Everything wraps. `size` must be a power
 * of two - the wrap is a mask, and that is what keeps the map tileable.
 */
export function buildLensDirt(gl, size = 512) {
  const px = new Uint8Array(size * size * 4);
  const val = new Float32Array(size * size);
  const M = size - 1;
  // Grease field on a coarse grid: it is only 5 cycles wide, so full-res fbm
  // here bought nothing and was the largest single cost in the whole kit.
  const CR = 48;
  const cf = mkField(CR, 5, 4);
  const clumpAt = (x, y) => sampleF(cf, CR, x / size, y / size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const g = Math.pow(clamp01((clumpAt(x, y) - 0.36) / 0.48), 1.7);
      val[y * size + x] = 0.012 + g * 0.32;
    }
  }
  const add = (x, y, v) => { val[(y & M) * size + (x & M)] += v; };

  // Big out-of-focus motes. These are the ones that actually read on screen.
  for (let i = 0; i < 26; i++) {
    const cx = hash2(i, 11) * size, cy = hash2(i, 23) * size;
    const rad = 20 + Math.pow(hash2(i, 37), 1.8) * 72;
    const amp = (0.20 + hash2(i, 53) * 0.40) * (0.35 + clumpAt(cx, cy));
    const r2 = rad * rad;
    for (let y = (cy - rad) | 0; y <= cy + rad; y++) {
      const dy = y - cy;
      for (let x = (cx - rad) | 0; x <= cx + rad; x++) {
        const dx = x - cx, d2 = dx * dx + dy * dy;
        if (d2 >= r2) continue;
        add(x, y, amp * Math.pow(1 - Math.sqrt(d2) / rad, 1.7));
      }
    }
  }

  // Fine dust, amplitude weighted by the grease field so it clusters.
  for (let i = 0; i < 700; i++) {
    const cx = hash2(i, 131) * size, cy = hash2(i, 149) * size;
    const w = clumpAt(cx, cy);
    if (w < 0.34) continue;                            // clean glass stays clean
    const rad = 1.6 + Math.pow(hash2(i, 163), 3) * 8;
    const amp = (0.20 + hash2(i, 179) * 0.60) * w;
    const r2 = rad * rad;
    for (let y = (cy - rad) | 0; y <= cy + rad; y++) {
      const dy = y - cy;
      for (let x = (cx - rad) | 0; x <= cx + rad; x++) {
        const dx = x - cx, d2 = dx * dx + dy * dy;
        if (d2 >= r2) continue;
        add(x, y, amp * Math.pow(1 - Math.sqrt(d2) / rad, 2.0));
      }
    }
  }

  // Finger grease: broad soft smears, fading in and out along their length. The
  // kernel runs to 2.6 sigma, because truncating it left a hard-edged slab.
  for (let i = 0; i < 16; i++) {
    const ang = hash2(i, 71) * TAU, L = size * (0.10 + hash2(i, 83) * 0.30);
    const halfW = 5 + hash2(i, 89) * 16;
    let x = hash2(i, 97) * size, y = hash2(i, 101) * size;
    const dx = Math.cos(ang), dy = Math.sin(ang);
    const amp = (0.10 + hash2(i, 103) * 0.22) * (0.4 + clumpAt(x, y));
    const iw = (halfW * 2.6 + 1) | 0;
    for (let s = 0; s < L; s++) {
      const env = Math.sin((s / L) * Math.PI);
      const a = amp * env * env;
      const w = halfW * (0.5 + 0.5 * env);
      for (let o = -iw; o <= iw; o++) {
        add(Math.round(x - dy * o), Math.round(y + dx * o), a * Math.exp(-(o * o) / (w * w)));
      }
      x += dx; y += dy;
    }
  }

  // Cleaning-cloth swirls: thin faint arcs, not the straight lines the old map
  // had - straight bright scratches read as damaged film, not dirty glass.
  for (let i = 0; i < 9; i++) {
    const ox = hash2(i, 211) * size, oy = hash2(i, 223) * size;
    const rad = size * (0.10 + hash2(i, 227) * 0.28);
    const a0 = hash2(i, 229) * TAU, span = 0.5 + hash2(i, 233) * 2.0;
    const amp = 0.07 + hash2(i, 239) * 0.13;
    const steps = (rad * span) | 0;
    for (let s = 0; s < steps; s++) {
      const t = s / steps, ang = a0 + span * t;
      const env = Math.sin(t * Math.PI);
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const x = ox + ca * rad, y = oy + sa * rad;
      for (let o = -3; o <= 3; o++) {
        add(Math.round(x + ca * o), Math.round(y + sa * o), amp * env * Math.exp(-(o * o) / 2.4));
      }
    }
  }

  for (let i = 0; i < size * size; i++) {
    const v = Math.round(clamp01(val[i]) * 255);
    px[i * 4] = v; px[i * 4 + 1] = v; px[i * 4 + 2] = v; px[i * 4 + 3] = 255;
  }
  return texture2D(gl, { width: size, height: size, data: px, wrap: gl.REPEAT, mips: true });
}

/**
 * 1-D LUT strip for spectral / chromatic sampling in post: blue at t=0 through
 * to red at t=1. Each channel is normalised to the same mean, so summing taps
 * across the strip is neutral - an un-normalised ramp tints the whole frame.
 */
export function buildSpectrumTexture(gl, width = 256) {
  const px = new Uint8Array(width * 4);
  const ch = [new Float32Array(width), new Float32Array(width), new Float32Array(width)];
  const g = (t, mu, sg) => Math.exp(-Math.pow((t - mu) / sg, 2));
  for (let i = 0; i < width; i++) {
    const t = i / (width - 1);
    ch[0][i] = g(t, 0.88, 0.20) + 0.62 * g(t, 0.64, 0.15) + 0.20 * g(t, 0.03, 0.09);
    ch[1][i] = g(t, 0.56, 0.19) + 0.34 * g(t, 0.36, 0.13);
    ch[2][i] = g(t, 0.20, 0.17) + 0.30 * g(t, 0.40, 0.11);
  }
  let peak = 0;
  for (let c = 0; c < 3; c++) {
    let sum = 0;
    for (let i = 0; i < width; i++) sum += ch[c][i];
    const k = width * 0.5 / sum;                       // equalise the means
    for (let i = 0; i < width; i++) { ch[c][i] *= k; if (ch[c][i] > peak) peak = ch[c][i]; }
  }
  for (let i = 0; i < width; i++) {
    for (let c = 0; c < 3; c++) px[i * 4 + c] = Math.round(clamp01(ch[c][i] / peak) * 255);
    px[i * 4 + 3] = 255;
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
