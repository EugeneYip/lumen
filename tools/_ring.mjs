#!/usr/bin/env node
/**
 * Angular-repeat detector: is a creature one primitive rotated N times?
 *
 *   node tools/_ring.mjs --at 903,393 --r 20,90 shots/a/f.png
 *   node tools/_ring.mjs --at 255,587 --r 12,70 --sector -180,0 shots/a/f.png
 *
 * `_comb.mjs` autocorrelates COLUMN means, so it can only see a period that is
 * a period *in x*. N spokes evenly spaced in ANGLE project onto x at
 * R*cos(theta_k), which is arccos-distributed and not periodic in x at all - so
 * _comb has almost no power against a radial asterisk and reports the shading
 * under it instead. This is _comb's spectral machinery (moving-average detrend,
 * amplitude at a period, contrast against the local broadband median) run on
 * the same signal resampled in THETA about the creature's own centre, which is
 * the axis the defect actually lives on.
 *
 * Reports, over a radial band r0..r1 px about (cx,cy):
 *   fold      the strongest angular harmonic m (m repeats around the circle)
 *             and its contrast against the local broadband floor. A single
 *             primitive rotated N times is a spectral line at m = N.
 *   tipR      dispersion of the per-angle brightest radius. "at even radius"
 *             is a small sigma/mean; real growth has a large one.
 *   armE      per-arm energy dispersion. Identical elements => small.
 *
 * Not a gate. Compare builds on the same object, and look at the crop.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const [CX, CY] = String(arg('at', '0,0')).split(',').map(Number);
const [R0, R1] = String(arg('r', '20,90')).split(',').map(Number);
const SECTOR = arg('sector', null);          // degrees, e.g. "-180,0" for a fan
// Background plate rendered by _iso.mjs with the creature removed; subtracted
// so the annulus contains the animal and nothing else.
const SUB = arg('sub', null);
const BINS = Number(arg('bins', 720));
const MMAX = Number(arg('mmax', 30));
// The detrend removes everything slower than a sixth of the span, so harmonics
// below that are zero over zero and report an infinite contrast. Search above it.
const MLO = Number(arg('mlo', 5));
const taken = new Set();
for (const k of ['at', 'r', 'sector', 'bins', 'mmax', 'mlo', 'sep', 'nlo', 'nhi', 'sub', 'atn']) {
  const i = argv.indexOf('--' + k); if (i >= 0) { taken.add(i); taken.add(i + 1); }
}
const files = argv.filter((a, i) => !taken.has(i) && !a.startsWith('--'));
if (!files.length) { console.error('usage: _ring.mjs --at cx,cy --r r0,r1 [--sector a0,a1] <png>...'); process.exit(2); }

const server = createServer(async (q, r) => {
  if (q.url === '/') { r.writeHead(200, { 'content-type': 'text/html' }); return r.end('<canvas id=c></canvas>'); }
  try {
    const f = join(ROOT, normalize(decodeURIComponent(new URL(q.url, 'http://x').pathname)));
    await stat(f); r.writeHead(200, { 'content-type': 'image/png' }); r.end(await readFile(f));
  } catch { r.writeHead(404); r.end(); }
});
await new Promise((res) => server.listen(0, res));
const port = server.address().port;
const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${port}/`);

/** Mean luminance per angular bin over the band, plus the brightest radius. */
async function polar(url, subUrl) {
  return page.evaluate(async (u, su, cx, cy, r0, r1, bins, sector) => {
    const grab = async (src) => {
      const img = new Image(); img.src = src; await img.decode();
      const c = document.getElementById('c'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
      return { d: g.getImageData(0, 0, img.width, img.height).data, w: img.width, h: img.height };
    };
    const A = await grab(u);
    const B = su ? await grab(su) : null;
    const img = { width: A.w, height: A.h };
    const D = A.d;
    const lum = (x, y) => {
      const xi = Math.round(x), yi = Math.round(y);
      if (xi < 0 || yi < 0 || xi >= img.width || yi >= img.height) return NaN;
      const k = (yi * img.width + xi) * 4;
      let v = 0.2126 * D[k] + 0.7152 * D[k + 1] + 0.0722 * D[k + 2];
      if (B) v = Math.max(0, v - (0.2126 * B.d[k] + 0.7152 * B.d[k + 1] + 0.0722 * B.d[k + 2]));
      return v;
    };
    const a0 = sector ? (sector[0] * Math.PI) / 180 : 0;
    const span = sector ? ((sector[1] - sector[0]) * Math.PI) / 180 : 2 * Math.PI;
    const mean = new Array(bins).fill(0);
    const tip = new Array(bins).fill(0);
    const pk = new Array(bins).fill(0);
    const steps = Math.max(8, Math.round(r1 - r0));
    const map = new Array(bins * (steps + 1)).fill(0);
    for (let b = 0; b < bins; b++) {
      const th = a0 + (span * b) / bins;
      const ct = Math.cos(th), st = Math.sin(th);
      let s = 0, cnt = 0, best = -1, bestR = r0;
      for (let k = 0; k <= steps; k++) {
        const r = r0 + ((r1 - r0) * k) / steps;
        const v = lum(cx + ct * r, cy + st * r);
        map[b * (steps + 1) + k] = Number.isNaN(v) ? 0 : v;
        if (Number.isNaN(v)) continue;
        s += v; cnt++;
        if (v > best) { best = v; bestR = r; }
      }
      mean[b] = cnt ? s / cnt : 0;
      tip[b] = bestR;
      pk[b] = best;
    }
    return { mean, tip, pk, map, rows: steps + 1 };
  }, url, subUrl, CX, CY, R0, R1, BINS, SECTOR ? SECTOR.split(',').map(Number) : null);
}

/** _comb.mjs's statistic, on a circular (or sector) signal indexed by harmonic. */
function analyse(sig) {
  const n = sig.length;
  const circular = !SECTOR;
  // Detrend: circular moving average over a third of the span, so the object's
  // overall lighting gradient does not masquerade as an m=1..3 line.
  const half = Math.max(2, Math.floor(n / 6));
  const at = circular
    ? (i) => sig[((i % n) + n) % n]
    : (i) => sig[i < 0 ? -i : i >= n ? 2 * n - 2 - i : i];
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -half; k <= half; k++) s += at(i + k);
    x[i] = sig[i] - s / (2 * half + 1);
  }
  // A sector is not periodic, so window it; a full circle is, so do not.
  const w = new Float64Array(n); let wsum = 0;
  for (let i = 0; i < n; i++) {
    w[i] = circular ? 1 : 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    wsum += w[i];
  }
  const amp = (m) => {
    const f = (2 * Math.PI * m) / n;
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) { const v = x[i] * w[i]; re += v * Math.cos(f * i); im += v * Math.sin(f * i); }
    return (2 * Math.hypot(re, im)) / wsum;
  };
  const A = []; for (let m = 1; m <= MMAX; m++) A.push(amp(m));
  // Contrast against the local broadband floor, exactly as _comb does.
  const contrast = (m) => {
    const near = [];
    for (let k = 1; k <= MMAX; k++) {
      const rr = k / m;
      if (rr > 1 / 1.6 && rr < 1.6 && (rr < 1 / 1.12 || rr > 1.12)) near.push(A[k - 1]);
    }
    near.sort((u, v) => u - v);
    const med = near.length ? near[near.length >> 1] : 1e-9;
    return A[m - 1] / Math.max(med, 1e-9);
  };
  let bm = MLO, bc = 0;
  for (let m = MLO; m <= MMAX; m++) { const c = contrast(m); if (c > bc) { bc = c; bm = m; } }
  let rms = 0; for (let i = 0; i < n; i++) rms += x[i] * x[i];
  return { rms: Math.sqrt(rms / n), A, contrast, bestM: bm, bestC: bc, bestA: A[bm - 1] };
}


/**
 * Per-ELEMENT dispersion, which is the statistic the angular spectrum cannot
 * supply and the one the review's words actually name.
 *
 * "Near-identical spokes at near-equal angular spacing at even radius" is three
 * coefficients of variation, not a period: over the arms the object actually
 * has, how much do the ANGULAR GAPS between them vary, how much do their
 * RADII vary, and how much do their PEAK VALUES vary. A spectral line needs the
 * elements to be evenly spaced to exist at all, so it goes to the noise floor
 * the moment any jitter is added and then cannot distinguish "jittered copies
 * of one primitive" from "eleven different arms". These three can.
 *
 * Peaks are picked greedily by height with a minimum angular separation and a
 * floor at the midpoint between the median and the max of the ray-peak signal,
 * so the count is the number of distinguishable elements rather than a
 * parameter.
 */
function elements(pk, tip, sepDeg, spanDeg) {
  const n = pk.length;
  const circular = spanDeg >= 359;
  // Light smoothing: one spine is several bins wide and its own grain must not
  // split it into three elements.
  const sm = new Float64Array(n);
  const W = 2;
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let k = -W; k <= W; k++) {
      const j = circular ? ((i + k) % n + n) % n : i + k;
      if (j < 0 || j >= n) continue;
      s += pk[j]; c++;
    }
    sm[i] = s / c;
  }
  const sorted = Array.from(sm).sort((a, b) => a - b);
  const med = sorted[n >> 1], mx = sorted[n - 1];
  const floor = med + (mx - med) * 0.35;
  const sep = Math.max(2, Math.round((sepDeg / spanDeg) * n));
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => sm[b] - sm[a]);
  const acc = [];
  for (const i of order) {
    if (sm[i] < floor) break;
    let ok = true;
    for (const j of acc) {
      let d = Math.abs(i - j);
      if (circular) d = Math.min(d, n - d);
      if (d < sep) { ok = false; break; }
    }
    if (ok) acc.push(i);
  }
  acc.sort((a, b) => a - b);
  if (acc.length < 3) return null;
  const gaps = [];
  for (let i = 1; i < acc.length; i++) gaps.push(acc[i] - acc[i - 1]);
  if (circular) gaps.push(n - acc[acc.length - 1] + acc[0]);
  const cv = (a) => {
    const m = a.reduce((s, v) => s + v, 0) / a.length;
    const sd = Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / a.length);
    return { m, cv: sd / Math.max(m, 1e-9) };
  };
  return {
    n: acc.length,
    gap: cv(gaps.map((g) => (g / n) * spanDeg)),
    rad: cv(acc.map((i) => tip[i])),
    amp: cv(acc.map((i) => sm[i])),
  };
}


/**
 * Rotational self-similarity of the WHOLE object, which is the only statistic
 * here with real power against "one primitive rotated N times".
 *
 * Every other number in this file collapses the object onto one dimension - a
 * spectrum of the angular mean, or a list of per-element scalars - and a
 * primitive's SHAPE does not survive that. Where each element starts, how it
 * curves, whether it is a long spine or a short stub, how its width changes at
 * the joint: all of those are two-dimensional and all of them are invisible to
 * a per-angle statistic. So correlate the polar map P(theta, r) against itself
 * rotated by 2*pi/N and maximise over N. A rotation of one primitive scores
 * near 1 by construction; genuinely different elements cannot.
 *
 * Reported as the best N and its Pearson r over the whole annulus.
 */
function selfSim(map, bins, rows, nlo, nhi, atn) {
  let m = 0;
  for (let i = 0; i < map.length; i++) m += map[i];
  m /= map.length;
  let den = 0;
  for (let i = 0; i < map.length; i++) den += (map[i] - m) * (map[i] - m);
  if (den <= 0) return null;
  let bestN = nlo, bestR = -2, atR = null;
  for (let N = nlo; N <= nhi; N++) {
    const sh = Math.round(bins / N);
    if (sh < 2) continue;
    let num = 0;
    for (let b = 0; b < bins; b++) {
      const b2 = (b + sh) % bins;
      for (let k = 0; k < rows; k++) {
        num += (map[b * rows + k] - m) * (map[b2 * rows + k] - m);
      }
    }
    const r = num / den;
    if (N === atn) atR = r;
    if (r > bestR) { bestR = r; bestN = N; }
  }
  return { n: bestN, r: bestR, atR };
}

const stats = (a) => {
  const m = a.reduce((s, v) => s + v, 0) / a.length;
  const sd = Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / a.length);
  return { m, sd, cv: sd / Math.max(m, 1e-9) };
};

console.log(`\nangular-repeat spectrum  centre ${CX},${CY}  band ${R0}-${R1}px  ${SECTOR ? `sector ${SECTOR}deg` : 'full circle'}  ${BINS} bins\n`);
for (const f of files) {
  try {
    const { mean, tip, pk, map, rows } = await polar(`http://127.0.0.1:${port}/${f}`, SUB === 'auto' ? `http://127.0.0.1:${port}/${f.replace('.png', '-bg.png')}` : SUB ? `http://127.0.0.1:${port}/${SUB}` : null);
    const a = analyse(mean);
    const tp = stats(tip);
    console.log(`  ${f}`);
    console.log(`      angular rms ${a.rms.toFixed(3)} code   strongest fold m=${a.bestM} amp ${a.bestA.toFixed(3)} contrast ${a.bestC.toFixed(2)}x`);
    const top = a.A.map((v, i) => ({ m: i + 1, v, c: a.contrast(i + 1) })).filter((o) => o.m >= MLO)
      .sort((u, v) => v.c - u.c).slice(0, 5)
      .map((o) => `m${o.m}:${o.c.toFixed(2)}x`).join(' ');
    console.log(`      top folds by contrast   ${top}`);
    console.log(`      tip radius  mean ${tp.m.toFixed(1)}px  sd ${tp.sd.toFixed(2)}  cv ${tp.cv.toFixed(3)}`);
    const spanDeg = SECTOR ? (SECTOR.split(',').map(Number)[1] - SECTOR.split(',').map(Number)[0]) : 360;
    const el = elements(pk, tip, Number(arg('sep', 9)), spanDeg);
    if (el) console.log(`      elements n=${el.n}  gap cv ${el.gap.cv.toFixed(3)} (mean ${el.gap.m.toFixed(1)}deg)   radius cv ${el.rad.cv.toFixed(3)} (mean ${el.rad.m.toFixed(1)}px)   peak cv ${el.amp.cv.toFixed(3)}`);
    else console.log('      elements: fewer than 3 resolvable');
    const ss = selfSim(map, BINS, rows, Number(arg('nlo', 5)), Number(arg('nhi', 22)), Number(arg('atn', 0)));
    { let mm=0,mx=0; for(const v of map){mm+=v; if(v>mx)mx=v;} console.log(`      [dbg] map mean ${(mm/map.length).toFixed(4)} max ${mx.toFixed(1)} rows ${rows} len ${map.length}`); }
    if (ss) console.log(`      rot self-similarity  best N=${ss.n}  r ${ss.r.toFixed(3)}${ss.atR === null || ss.atR === undefined ? '' : `   at N=${arg('atn',0)}: r ${ss.atR.toFixed(3)}`}`);
  } catch (e) { console.log(`  ${f}  ${e.message}`); }
}
console.log('');
await browser.close(); server.close();
