#!/usr/bin/env node
/**
 * DIRECTIONAL ruled-hairline detector.  Scratch instrument.
 *
 *   node hairdir.mjs [--region x,y,w,h] [--self] <png> [png...]
 *
 * _hair.mjs scans one direction only (neighbours at +-3/+-4 columns on a
 * horizontal scanline), so it detects near-VERTICAL lines and is blind to
 * horizontal ones.  "No two strokes share an angle" is a statement about the
 * ORIENTATION DISTRIBUTION, which a single-direction scan cannot see at all.
 *
 * Here the neighbour pair is taken along u = (cos p, sin p) for p over 0..175
 * in 5 degree steps, which detects lines running along u rotated 90 degrees.
 * Report per angle: mean positive notch, and the count of deep (>3 level)
 * notches.  Then:
 *
 *   aniso = max_p(deep_p) / mean_p(deep_p)      how concentrated in one angle
 *
 * A field of strokes that all share an angle concentrates its deep notches in
 * one or two bins; a field whose angles wander spreads them.  --self renders
 * two synthetic controls first (ruled / wandering, identical stroke count,
 * length, width and contrast) and prints them, so the instrument's power on
 * this exact axis is demonstrated before it is pointed at the art.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, resolve } from 'node:path';
import puppeteer from 'puppeteer';

// Derived, not hardcoded: this file used to carry an absolute path to the
// author's home directory, which silently pointed at a DIFFERENT checkout when
// run from a worktree and would have broken outright on relocation.
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const ri = argv.indexOf('--region');
const [RX, RY, RW, RH] = (ri < 0 ? '920,100,300,220' : argv[ri + 1]).split(',').map(Number);
const SELF = argv.includes('--self');
const files = argv.filter((a, i) => (ri < 0 || (i !== ri && i !== ri + 1)) && !a.startsWith('--'));

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

await page.evaluate(() => {
  // Shared analysis: luminance field -> per-angle notch statistics.
  window.analyse = (L, W, H) => {
    const NA = 36, out = [];
    for (let a = 0; a < NA; a++) {
      const p = (a * 5) * Math.PI / 180;
      const ux = Math.cos(p), uy = Math.sin(p);
      // Bilinear, not rounded: at 5 degree steps round(3*cos p) and
      // round(4*sin p) collide for several consecutive angles, and the profile
      // came out piecewise constant in runs of three - the instrument had no
      // angular resolution at all near the axes.
      const at = (x, y) => {
        const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
        const a = L[y0 * W + x0], b = L[y0 * W + x0 + 1];
        const c = L[(y0 + 1) * W + x0], d = L[(y0 + 1) * W + x0 + 1];
        return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
      };
      let sum = 0, n = 0, deep = 0;
      for (let j = 5; j < H - 5; j++) for (let i = 5; i < W - 5; i++) {
        const s = [3, 4, -3, -4].map((k) => at(i + ux * k, j + uy * k)).sort((q, r) => q - r);
        const notch = (s[1] + s[2]) / 2 - L[j * W + i];
        if (notch > 0) { sum += notch; n++; if (notch > 3) deep++; }
      }
      out.push({ deg: a * 5, mean: sum / Math.max(n, 1), deep });
    }
    // A dark line is darker than its neighbours in EVERY sampling direction
    // except the one running ALONG it, where the neighbours sit on the line
    // too. So the discriminating feature is the MINIMUM over angle, not the
    // maximum: a field whose strokes share an angle has one direction in which
    // almost nothing registers, and a field whose angles wander has none.
    const deeps = out.map((o) => o.deep);
    const mx = Math.max(...deeps), mnv = Math.min(...deeps);
    const iMin = deeps.indexOf(mnv);
    const means = out.map((o) => o.mean);
    const mmx = Math.max(...means), mmn = Math.min(...means);
    return {
      // How much of the notch energy is carried by strokes at ONE angle.
      ruled: +(1 - mnv / Math.max(mx, 1e-9)).toFixed(3),
      ruledMean: +(1 - mmn / Math.max(mmx, 1e-9)).toFixed(3),
      // Sampling along the strokes is the blind direction, so the minimum
      // names the stroke orientation directly (0 = horizontal, 90 = vertical).
      strokeDeg: out[iMin].deg,
      minDeep: mnv, maxDeep: mx,
      prof: out.map((o) => o.deep),
    };
  };
  window.fromCanvas = (g, W, H) => {
    const d = g.getImageData(0, 0, W, H).data;
    const L = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) L[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
    return L;
  };
});

if (SELF) {
  console.log('\n  CONTROL: identical stroke count, length, width, contrast; only the angle distribution differs\n');
  for (const spread of [0, 6, 12, 18, 25, 40, 90]) {
    const v = await page.evaluate((SPREAD) => {
      const W = 400, H = 300;
      const c = document.getElementById('c'); c.width = W; c.height = H;
      const g = c.getContext('2d');
      g.fillStyle = '#2a3a44'; g.fillRect(0, 0, W, H);
      // Deterministic LCG so the two controls differ ONLY in angle spread.
      let s = 12345; const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
      g.strokeStyle = '#101820'; g.lineWidth = 1.4;
      for (let k = 0; k < 90; k++) {
        const x = rnd() * W, y = rnd() * H, len = 46;
        const jitter = (rnd() - 0.5) * 2 * SPREAD;
        const th = (20 + jitter) * Math.PI / 180;
        g.beginPath();
        g.moveTo(x - Math.sin(th) * len / 2, y - Math.cos(th) * len / 2);
        g.lineTo(x + Math.sin(th) * len / 2, y + Math.cos(th) * len / 2);
        g.stroke();
      }
      return { ...window.analyse(window.fromCanvas(g, W, H), W, H), png: c.toDataURL() };
    }, spread);
    if (process.env.DUMP) {
      const fs = await import('node:fs/promises');
      await fs.writeFile(`${process.env.DUMP}/ctl-${spread}.png`, Buffer.from(v.png.split(',')[1], 'base64'));
    }
    console.log(`  spread +-${String(spread).padStart(2)} deg   ruled ${String(v.ruled).padStart(6)}  ruledMean ${String(v.ruledMean).padStart(6)}  strokeDeg ${String(v.strokeDeg).padStart(3)}  minDeep ${String(v.minDeep).padStart(6)}  maxDeep ${String(v.maxDeep).padStart(6)}`);
  }
  console.log('');
}

if (files.length) {
  console.log(`  directional notch  region ${RX},${RY} ${RW}x${RH}\n`);
  for (const f of files) {
    const v = await page.evaluate(async (url, X0, Y0, W, H) => {
      const img = new Image(); img.src = url; await img.decode();
      const c = document.getElementById('c'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      if (X0 + W > img.width || Y0 + H > img.height) return { err: 'region outside image' };
      const d = g.getImageData(X0, Y0, W, H).data;
      const L = new Float32Array(W * H);
      for (let i = 0; i < W * H; i++) L[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
      return window.analyse(L, W, H);
    }, `http://127.0.0.1:${port}/${f}`, RX, RY, RW, RH);
    if (v.err) { console.log(`  ${f.padEnd(42)} ${v.err}`); continue; }
    console.log(`  ${f.padEnd(42)} ruled ${String(v.ruled).padStart(6)}  ruledMean ${String(v.ruledMean).padStart(6)}  strokeDeg ${String(v.strokeDeg).padStart(3)}  minDeep ${String(v.minDeep).padStart(6)}  maxDeep ${String(v.maxDeep).padStart(6)}`);
    if (process.env.PROF) console.log('    prof ' + v.prof.join(','));
  }
  console.log('');
}
await browser.close(); server.close();
