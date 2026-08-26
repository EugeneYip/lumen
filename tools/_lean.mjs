#!/usr/bin/env node
/**
 * The far-wall joint set's ANGLE DISTRIBUTION, measured off the level set
 * itself rather than off a rendered frame.
 *
 * A rendered frame carries grain, four superposed layers, camera roll, bloom
 * and the bedding, all of which dilute an angle statistic. The question "do
 * two strokes share an angle" is a property of the field, and the field is
 * cheap to evaluate here. This traces each joint core - the curve where the
 * in-cell distance is zero - down a range of y and reports the distribution of
 * its local lean, and separately how far ADJACENT joints differ at the same y,
 * which is the thing the eye reads as 'parallel'.
 *
 *   node lean.mjs [warp|nowarp]
 */
const MODE = process.argv[2] || 'warp';
const AMP  = Number(process.env.AMP  || 4624);   // curl potential amplitude
const L0   = Number(process.env.L0   || 0.62);   // base lean
const KX   = Number(process.env.KX   || 0.005464);
const KY   = Number(process.env.KY   || 0.008055);
const MEA  = Number(process.env.MEA  || 0.045);  // meander amplitude, cells
const SHR  = Number(process.env.SHR  || 0.10);   // global shear amplitude
const fract = (x) => x - Math.floor(x);
const hash11 = (p) => { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); };
const wave = (x, f, ph) => Math.sin(x * f + ph) * 0.62 + Math.sin(x * f * 2.317 + ph * 2.7) * 0.38;

// jsx as the shader computes it, for one layer seed.
function jsx(x, y, seed) {
  let qx = x, qy = y, lean = 0.44, shear = 0.17;
  if (MODE === 'warp') {
    const wa = x * KX + seed * 2.7, wb = y * KY + seed * 1.3;
    qx = x + AMP * KY * Math.sin(wa) * Math.cos(wb);
    qy = y - AMP * KX * Math.cos(wa) * Math.sin(wb);
    lean = L0; shear = SHR;
  }
  return (qx + qy * lean) / 186.0 + wave(qy, 0.00130, 3.1 + seed) * shear;
}
// The full in-cell signed distance for a FIXED cell index, so it is continuous
// across the cell and can be root-found. Matches the shader's jd argument.
function G(x, y, ji, seed) {
  const jh = hash11(ji * 3.17 + 1.9);
  const p = hash11(ji * 7.13 + 4.7) * 43.7 + seed;
  const fk = MODE === 'warp' ? 0.62 + fract(p * 0.317) * 1.05 : 1.0;
  const amp = MODE === 'warp' ? MEA : 0.105;
  const s1 = Math.sin(y * 0.0031 * fk + p);
  const s2 = Math.sin(y * 0.0119 * fk + p * 2.7);
  return (jsx(x, y, seed) - ji) - 0.5 + (jh - 0.5) * 0.30 + (s1 * 0.72 + s2 * 0.28) * amp;
}
function seg(y, ji, seed) {
  const p = hash11(ji * 7.13 + 4.7) * 43.7 + seed;
  const fk = MODE === 'warp' ? 0.62 + fract(p * 0.317) * 1.05 : 1.0;
  const s1 = Math.sin(y * 0.0031 * fk + p);
  const s2 = Math.sin(y * 0.0119 * fk + p * 2.7);
  return Math.max(0, Math.min(1, 0.52 + (s2 * 0.62 + s1 * 0.38) * 1.9));
}
// Solve G = 0 in x for a given y (dG/dx = 1/186 plus warp, always positive).
function coreX(y, ji, seed, x0) {
  let x = x0;
  for (let k = 0; k < 40; k++) {
    const g = G(x, y, ji, seed);
    const d = (G(x + 1, y, ji, seed) - G(x - 1, y, ji, seed)) / 2;
    if (Math.abs(d) < 1e-9) break;
    const step = Math.max(-400, Math.min(400, -g / d));
    x += step;
    if (Math.abs(step) < 1e-4) break;
  }
  return x;
}

// Four layers, their world scales as farWall is called with, over a world
// region the size of one screen at each layer's own magnification.
const LAYERS = [[0.58, 1.7], [0.40, 3.1], [0.25, 5.3], [0.135, 7.9]];
const leans = [], neigh = [];
for (const [s, seed] of LAYERS) {
  const spanX = 1920 / s, spanY = 1080 / s;
  const x0 = 4000, y0 = -600;
  const i0 = Math.floor(jsx(x0, y0, seed)), i1 = Math.floor(jsx(x0 + spanX, y0, seed));
  for (let ji = i0; ji <= i1; ji++) {
    if (hash11(ji * 3.17 + 1.9) <= 0.44) continue;
    let prev = null;
    for (let y = y0; y < y0 + spanY; y += spanY / 24) {
      if (seg(y, ji, seed) < 0.30) continue;
      const xc = coreX(y, ji, seed, x0 + (ji - i0) * 186);
      if (Math.abs(G(xc, y, ji, seed)) > 1e-3) continue;
      const h = 4;
      const dx = coreX(y + h, ji, seed, xc) - coreX(y - h, ji, seed, xc);
      const lean = -dx / (2 * h);            // dx/dy = -lean, as the shader means it
      const deg = Math.atan(lean) * 180 / Math.PI;
      leans.push(deg);
      if (prev !== null) neigh.push(deg - prev);
      prev = deg;
    }
  }
}
leans.sort((a, b) => a - b);
const q = (p) => leans[Math.min(leans.length - 1, Math.floor(p * leans.length))];
const mean = leans.reduce((a, b) => a + b, 0) / leans.length;
const sd = Math.sqrt(leans.reduce((a, b) => a + (b - mean) ** 2, 0) / leans.length);
console.log(`\n  ${MODE}  AMP ${AMP} L0 ${L0} KX ${KX} KY ${KY} MEA ${MEA} SHR ${SHR}  maxJ ${(AMP*Math.max(KX*KX,KY*KY,KX*KY)).toFixed(3)}  W ${(AMP*KY).toFixed(1)}/${(AMP*KX).toFixed(1)}  n=${leans.length}`);
console.log(`  lean angle off vertical, degrees (sign = which way it leans)`);
console.log(`     min ${q(0).toFixed(1)}   p05 ${q(0.05).toFixed(1)}   p25 ${q(0.25).toFixed(1)}   median ${q(0.5).toFixed(1)}   p75 ${q(0.75).toFixed(1)}   p95 ${q(0.95).toFixed(1)}   max ${q(0.999).toFixed(1)}`);
console.log(`     mean ${mean.toFixed(1)}   sd ${sd.toFixed(2)}   |min| off vertical ${Math.min(...leans.map(Math.abs)).toFixed(2)}`);
const frac = (t) => (100 * leans.filter((v) => Math.abs(v) < t).length / leans.length).toFixed(2);
console.log(`     within 8.9 deg of screen vertical (max camera roll): ${frac(8.9)}%   within 3 deg: ${frac(3)}%`);
console.log(`  step in lean ALONG one joint between samples: sd ${Math.sqrt(neigh.reduce((a, b) => a + b * b, 0) / neigh.length).toFixed(2)} deg\n`);
