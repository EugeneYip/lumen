#!/usr/bin/env node
/**
 * Periodic-silhouette detector: is a repeating cell width drawing a comb?
 *
 *   node tools/_comb.mjs --region 60,40,1480,260 shots/a/f.png ...
 *   node tools/_comb.mjs --region ... --expect 34,49,56,79,90,127,145 shots/a/f.png
 *   node tools/_comb.mjs --region ... --sub shots/nofar/f.png shots/a/f.png
 *
 * `_hair.mjs` answers "is there a hairline HERE"; it is blind to WHERE the
 * hairlines are, so a row of teeth at one spacing and the same teeth scattered
 * at random score identically. This answers the other half: it takes the mean
 * luminance of each COLUMN of a strip that straddles a silhouette, detrends it
 * (a comb is narrow-band; the shading under it is not), and autocorrelates.
 * A silhouette built on a repeating cell shows a spectral line at the cell
 * period and at its harmonics; rock does not.
 *
 * Why it exists: "a branch on a world coordinate has a locus" (AI_HANDOFF §6)
 * has now been found four times in this repository, and one of its forms is a
 * cell-hashed feature emitted once per cell. If the feature's position inside
 * its cell is jittered across less than the whole cell, the cell width survives
 * as a period even though nothing in the code draws a straight line, and the
 * eye reads a manufactured comb rather than rock. No frame-wide statistic and
 * no notch detector can see that; an autocorrelation of the silhouette can.
 *
 * Reading it. `r1` is the largest normalised autocorrelation over the lag
 * range, and `z` is how far that peak stands above the mean of all the other
 * lags in units of their own standard deviation. Broadband rock produces
 * r1 ~ 0.1-0.3 at an arbitrary lag with z ~ 2-3 (the largest of ~300 samples of
 * noise is a couple of sigma up by construction). A real comb is much larger
 * and lands on the SAME lag from several frames and several seeds, which is the
 * check that matters: a period that moves is not a period.
 *
 * --expect takes the lags a suspected cell width predicts, in pixels, and
 * prints r at each of them, so a negative result is a measurement rather than
 * the absence of one. Compute them from the layer geometry: for a cell of C
 * world units drawn on a parallax layer of scale s, the screen period is
 * C * s * pixelW / cam.viewW.
 *
 * Not a gate. Scale-dependent, region-dependent, and a genuinely regular rock
 * formation is allowed to exist. Compare builds and look at the crop.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const [RX, RY, RW, RH] = String(arg('region', '60,40,1480,260')).split(',').map(Number);
const EXPECT = String(arg('expect', '')).split(',').map(Number).filter((n) => n > 1);
const SUB = arg('sub', null);
// Rectify the difference. `--sub A --abs` makes the column signal |img - A|,
// which is what isolates ONE term: subtract a build with that term removed and
// the residue is the term itself, with the surface it sits on cancelled out.
const ABS = argv.includes('--abs');
const LAG0 = Number(arg('minlag', 8));
const LAG1 = Number(arg('maxlag', 320));
// Detrend window. Wider than the longest lag of interest, or the detrend eats
// the very period it is meant to expose.
const TREND = Number(arg('trend', 2 * LAG1));
const taken = new Set();
for (const k of ['region', 'expect', 'sub', 'minlag', 'maxlag', 'trend']) {
  const i = argv.indexOf('--' + k); if (i >= 0) { taken.add(i); taken.add(i + 1); }
}
const files = argv.filter((a, i) => !taken.has(i) && !a.startsWith('--'));
if (!files.length) { console.error('usage: _comb.mjs [--region x,y,w,h] [--expect px,px] [--sub base.png] <png> [png...]'); process.exit(2); }

const server = createServer(async (q, r) => {
  if (q.url === '/') { r.writeHead(200, { 'content-type': 'text/html' }); return r.end('<canvas id=c></canvas><canvas id=d></canvas>'); }
  try {
    const f = join(ROOT, normalize(decodeURIComponent(new URL(q.url, 'http://x').pathname)));
    await stat(f); r.writeHead(200, { 'content-type': 'image/png' }); r.end(await readFile(f));
  } catch { r.writeHead(404); r.end(); }
});
await new Promise((res) => server.listen(0, res));
const port = server.address().port;

const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
// Same origin as the images, or getImageData taints.
await page.goto(`http://127.0.0.1:${port}/`);

/** Column means of the strip, minus a moving average, then autocorrelated. */
async function columns(url, subUrl) {
  return page.evaluate(async (u, su, X0, Y0, W, H, ab) => {
    const load = async (src, id) => {
      const img = new Image(); img.src = src; await img.decode();
      const c = document.getElementById(id); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
      if (X0 + W > img.width || Y0 + H > img.height) throw new Error(`region outside ${img.width}x${img.height}`);
      return g.getImageData(X0, Y0, W, H).data;
    };
    const a = await load(u, 'c');
    const b = su ? await load(su, 'd') : null;
    const col = new Float64Array(W);
    for (let i = 0; i < W; i++) {
      let s = 0;
      for (let j = 0; j < H; j++) {
        const k = (j * W + i) * 4;
        let v = 0.2126 * a[k] + 0.7152 * a[k + 1] + 0.0722 * a[k + 2];
        if (b) { v -= 0.2126 * b[k] + 0.7152 * b[k + 1] + 0.0722 * b[k + 2]; if (ab) v = Math.abs(v); }
        s += v;
      }
      col[i] = s / H;
    }
    return Array.from(col);
  }, url, subUrl, RX, RY, RW, RH, ABS);
}

/**
 * Detrend, window, and take the amplitude spectrum at a dense ladder of
 * periods. A plain autocorrelation is the wrong instrument here and it was
 * tried first: rock is broadband, so r(L) decays smoothly from ~0.9 at the
 * shortest lag to negative at the longest and the largest value is always the
 * shortest lag, whatever the image contains. A comb is a narrow LINE, so what
 * has to be measured is its height above the LOCAL broadband floor, not above
 * the average over all lags.
 */
function analyse(col) {
  const n = col.length;
  // Moving-average detrend, reflected at the ends so the boundary does not
  // invent a ramp. Wider than the longest period of interest, or the detrend
  // eats the very line it is meant to expose.
  const half = Math.max(2, Math.floor(TREND / 2));
  const at = (i) => col[i < 0 ? -i : i >= n ? 2 * n - 2 - i : i];
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -half; k <= half; k++) s += at(i + k);
    x[i] = col[i] - s / (2 * half + 1);
  }
  let rms = 0; for (let i = 0; i < n; i++) rms += x[i] * x[i];
  rms = Math.sqrt(rms / n);
  // Hann, so a line that is not on an exact bin does not smear into its
  // neighbours and pretend to be broadband.
  const w = new Float64Array(n);
  let wsum = 0;
  for (let i = 0; i < n; i++) { w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)); wsum += w[i]; }

  // Amplitude at an arbitrary period, in code values of column-mean modulation.
  const amp = (p) => {
    const f = (2 * Math.PI) / p;
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) { const v = x[i] * w[i]; re += v * Math.cos(f * i); im += v * Math.sin(f * i); }
    return (2 * Math.hypot(re, im)) / wsum;
  };
  // Log-spaced ladder: equal resolving power at every period.
  const P = [];
  const steps = 400;
  for (let k = 0; k <= steps; k++) P.push(LAG0 * Math.pow(LAG1 / LAG0, k / steps));
  const A = P.map(amp);

  // Line contrast: amplitude over the MEDIAN amplitude of the surrounding
  // half-octave, excluding the line's own resolution width. 1.0 is "nothing
  // here"; a comb in these frames has to clear the noise ceiling this measures.
  const contrast = (p) => {
    const a0 = amp(p);
    const near = [];
    for (let k = 0; k < P.length; k++) {
      const rr = P[k] / p;
      if (rr > 1 / 1.42 && rr < 1.42 && (rr < 1 / 1.09 || rr > 1.09)) near.push(A[k]);
    }
    near.sort((u, v) => u - v);
    const med = near.length ? near[near.length >> 1] : 1e-9;
    return { a: a0, c: a0 / Math.max(med, 1e-9) };
  };
  // The noise ceiling this statistic reaches on THIS image: the largest local
  // contrast anywhere in the band. A candidate period that does not beat it is
  // not a finding.
  let bi = 0;
  let bc = 0;
  for (let k = 0; k < P.length; k++) { const c = contrast(P[k]).c; if (c > bc) { bc = c; bi = k; } }
  return { rms, amp, contrast, bestP: P[bi], bestC: bc, bestA: A[bi] };
}

console.log(`\nperiodic-silhouette spectrum  region ${RX},${RY} ${RW}x${RH}  periods ${LAG0}-${LAG1}px${SUB ? `  minus ${SUB}` : ''}\n`);
for (const f of files) {
  try {
    const col = await columns(`http://127.0.0.1:${port}/${f}`, SUB ? `http://127.0.0.1:${port}/${SUB}` : null);
    const a = analyse(col);
    console.log(`  ${f}`);
    console.log(`      column rms ${a.rms.toFixed(3)} code    strongest line ${a.bestA.toFixed(3)} code at ${a.bestP.toFixed(1)}px, contrast ${a.bestC.toFixed(2)}x`);
    if (EXPECT.length) {
      const parts = EXPECT.map((p) => { const { a: v, c } = a.contrast(p); return `${p}px ${v.toFixed(3)}/${c.toFixed(2)}x`; });
      console.log(`      amp/contrast at expected periods: ${parts.join('   ')}`);
    }
  } catch (e) { console.log(`  ${f}  ${e.message}`); }
}
console.log('');
await browser.close(); server.close();
