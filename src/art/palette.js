// Art direction, in one place.
//
// The scene is a cold abyss (teal/void) lit by three warm-to-cool accents:
// amber anchors, mint plankton, and the violet edge of the Hush. Complementary
// amber-vs-cyan does the heavy lifting; magenta is reserved for danger so it
// never competes for attention.
import { hexToLin, lerp, clamp01, smoothstep } from '../engine/math.js';

const L = hexToLin;

export const PAL = {
  // --- environment ---
  voidDeep:   L(0x01060a),
  waterDeep:  L(0x04131c),
  waterMid:   L(0x0a2a38),
  waterHigh:  L(0x11485a),
  surface:    L(0x2f8fa3),
  silt:       L(0x1b4653),

  // --- the mote (player) ---
  moteCore:   L(0xf6ffff),
  moteInner:  L(0xa8fbff),
  moteOuter:  L(0x2ad6f0),
  moteTrail:  L(0x1ea8d8),

  // --- anchors: the warm counter-note ---
  anchorCore: L(0xfff3d0),
  anchorMid:  L(0xffb347),
  anchorRim:  L(0xff7a1a),
  anchorCold: L(0x6b4a2a),
  anchorLive: L(0xffd76e),

  // --- collectibles ---
  planktonCore: L(0xf2fff6),
  plankton:     L(0x86ffc4),
  planktonDim:  L(0x2f9e74),

  // --- danger ---
  hazard:     L(0xff2f63),
  hazardRim:  L(0xff8fae),
  hazardDark: L(0x2a0410),

  // --- the Hush ---
  hushEdge:   L(0x8a4dff),
  hushGlow:   L(0x3d1a7a),
  hushCore:   L(0x040108),

  // --- UI ---
  ink:        L(0xeaf7ff),
  inkDim:     L(0x7e9bab),
  inkFaint:   L(0x3d5361),
  accent:     L(0xffb347),
  good:       L(0x86ffc4),
  bad:        L(0xff2f63),
};

/**
 * Depth grading: everything fades toward `waterDeep` with distance so parallax
 * layers separate by value, not just by speed. `d` is 0 (foreground) .. 1 (far).
 */
export function depthFade(col, d, out = [0, 0, 0]) {
  const f = smoothstep(clamp01(d));
  const haze = PAL.waterDeep;
  const k = 0.86 * f;
  out[0] = lerp(col[0], haze[0], k);
  out[1] = lerp(col[1], haze[1], k);
  out[2] = lerp(col[2], haze[2], k);
  const dim = 1 - 0.72 * f;
  out[0] *= dim; out[1] *= dim; out[2] *= dim;
  return out;
}

/** Water absorbs red first: tint a light by how far it travels through water. */
export function absorb(col, metres, out = [0, 0, 0]) {
  const kR = 0.00042, kG = 0.00016, kB = 0.00009;
  out[0] = col[0] * Math.exp(-kR * metres);
  out[1] = col[1] * Math.exp(-kG * metres);
  out[2] = col[2] * Math.exp(-kB * metres);
  return out;
}

/** Blackbody-ish ramp for hot cores: t=0 amber, t=1 white-hot. */
export function heat(t, out = [0, 0, 0]) {
  t = clamp01(t);
  out[0] = lerp(1.0, 1.0, t);
  out[1] = lerp(0.62, 0.98, t);
  out[2] = lerp(0.22, 0.94, t);
  return out;
}

export function scaled(col, k, out = [0, 0, 0]) {
  out[0] = col[0] * k; out[1] = col[1] * k; out[2] = col[2] * k;
  return out;
}
