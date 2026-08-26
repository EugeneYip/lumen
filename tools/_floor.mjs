#!/usr/bin/env node
/**
 * _floor.mjs -- what is putting a pedestal under the darkest part of a frame?
 *
 *   node tools/_floor.mjs --seeds 7,3 --scenes tethered,launch --brief
 *   node tools/_floor.mjs --seeds 3 --scene tethered --set flash=0      # ablate one live term
 *   node tools/_floor.mjs --seeds 3 --scene tethered --grade black=0.0035  # price a grade change
 *   node tools/_floor.mjs --seeds 3 --scene tethered --advance 0.35     # let a transient decay
 *   node tools/_floor.mjs --seeds 3 --scene tethered --qs ";bgNoFar=1;noSprites=1"
 *
 * Reports, for the NATIVE-resolution final canvas: min, low percentiles, the
 * shadow fraction (<L8), a cumulative histogram of the bottom 24 code values,
 * the per-channel frame minimum, and an 8x8 map of each tile's 5th percentile.
 * `--brief` collapses that to one line per frame.
 *
 * WHY IT EXISTS. The `shadowFracMin` warning names an amount ("only 6.5% below
 * L8") and not a location, and three rounds were spent looking for a pedestal in
 * the art on the strength of it. The three switches above answer the question the
 * warning cannot:
 *   --set     pokes window.game before the measuring render, so a term is removed
 *             from an OTHERWISE IDENTICAL frame. Any difference IS that term.
 *   --grade   mutates the GRADE module singleton (postfx does `const G = GRADE`),
 *             so the cost of a grade change can be priced across all ten gate
 *             frames without editing a file.
 *   --advance runs the sim on, which decays a transient for real. It is the
 *             independent confirmation of whatever --set claims.
 *
 * WHAT IT FOUND (seed 3 / tethered, 2026-08, the "no real blacks" warning):
 * not the environment and not the grade. `startPlay()`'s 0.22 opening flash is
 * still lit at the sampled frame -- the `tethered` predicate gates on
 * `flash < 0.01` and therefore resolves on the first step the flash clears it, at
 * flash=0.0097 on BOTH seeds. postfx adds `flashCol * flash * 0.85` pre-tonemap;
 * flashCol [0.55,0.85,1] has Rec.709 luminance 0.797, so that residual is
 * +0.0066 linear on every pixel, against the frame's own linear p10 of 0.0048.
 * Ablating it: 6.56% -> 16.24% below L8 on seed 3, 10.78% -> 20.85% on seed 7.
 *
 * CAVEAT, and it cost a wrong conclusion here for ten minutes: the `hdr` column
 * is read from the sequential run, whereas check.mjs restarts the run before each
 * HDR measurement. The two are NOT comparable. Use this column to compare frames
 * within one invocation, never against the gate's printed HDR line.
 */
import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const ROOT = resolve(arg('root', new URL('..', import.meta.url).pathname));
const SEEDS = String(arg('seeds', arg('seed', '3'))).split(',').map(Number);
const SCENES = String(arg('scenes', arg('scene', 'tethered'))).split(',');
const QLIST = String(arg('qs', arg('q', ''))).split(';');
const W = Number(arg('w', 1600)), H = Number(arg('h', 900));
const DUMP = arg('dump', null);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.png': 'image/png', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if ((await stat(f)).isDirectory()) throw 0;
    const b = await readFile(f);
    res.writeHead(200, { 'Content-Type': MIME[extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': b.length });
    res.end(b);
  } catch { res.writeHead(404).end('404'); }
});
await new Promise(r => server.listen(0, r));
const PORT = server.address().port;

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--hide-scrollbars', '--mute-audio', '--font-render-hinting=none'] });

for (const seed of SEEDS) {
 for (const QS of QLIST) {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e?.message || e)));
  const url = `http://127.0.0.1:${PORT}/?headless=1&seed=${seed}${QS ? '&' + QS : ''}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction('window.LUMEN && window.LUMEN.ready === true', { timeout: 45000, polling: 50 });

  for (const sc of SCENES) {
    const info = sc === 'title'
      ? await page.evaluate(() => window.LUMEN.seekTo(0.001))
      : await page.evaluate((c) => window.LUMEN.seekUntil(c, 60), sc);

    // Counterfactual: mutate the GRADE singleton in the page. postfx.js does
    // `const G = GRADE`, so mutating the module export is exactly equivalent to
    // editing the default, and it costs no file write. This is how the cost of
    // a black-point change is priced across all ten frames.
    const GR = arg('grade', '');
    if (GR) await page.evaluate(async (s) => {
      const m = await import('/src/engine/postfx.js');
      for (const kv of s.split(',')) { const [k, v] = kv.split('='); if (k) m.GRADE[k] = Number(v); }
    }, GR);

    // Independent of the --set poke: let the sim run on so the flash decays for
    // real. If both routes agree, the flash is the term and not the poke.
    const ADV = Number(arg('advance', 0));
    const ADVSC = arg('advanceScene', '');
    if (ADV > 0 && (!ADVSC || ADVSC === sc)) await page.evaluate((s) => window.LUMEN.seekTo(window.game.t + s), ADV);

    const r = await page.evaluate((SET) => {
      // Poke live game state before the measuring render. This is how the
      // flash's contribution is isolated without touching a line of code:
      // `--set flash=0` renders the identical simulation state with one term
      // removed, so any difference IS that term.
      if (SET) for (const kv of SET.split(',')) {
        const [k, v] = kv.split('=');
        if (k) window.game[k] = Number(v);
      }
      window.game.render(1 / 120);
      const src = document.getElementById('gl');
      const f = document.createElement('canvas');
      f.width = src.width; f.height = src.height;
      const fx = f.getContext('2d', { willReadFrequently: true });
      fx.drawImage(src, 0, 0);
      const W2 = f.width, H2 = f.height;
      const fd = fx.getImageData(0, 0, W2, H2).data;
      const n = W2 * H2;
      const lum = new Float32Array(n);
      let sum = 0, min = 1e9, max = 0;
      // 8-bit code-value histogram, so "below L8" is exact rather than a float
      // comparison on a value that came from 8-bit data in the first place.
      const hist = new Int32Array(256);
      let minR = 255, minG = 255, minB = 255;
      for (let i = 0, j = 0; i < fd.length; i += 4, j++) {
        const l = (fd[i] * 0.2126 + fd[i + 1] * 0.7152 + fd[i + 2] * 0.0722) / 255;
        lum[j] = l; sum += l;
        if (l < min) min = l;
        if (l > max) max = l;
        hist[Math.min(255, Math.round(l * 255))]++;
        if (fd[i] < minR) minR = fd[i];
        if (fd[i + 1] < minG) minG = fd[i + 1];
        if (fd[i + 2] < minB) minB = fd[i + 2];
      }
      // Also: what is the per-channel minimum of the pixel with the lowest
      // luminance? A pedestal that is one channel only reads very differently
      // from a neutral lift.
      let darkI = 0; for (let j = 1; j < n; j++) if (lum[j] < lum[darkI]) darkI = j;
      const dpx = [fd[darkI * 4], fd[darkI * 4 + 1], fd[darkI * 4 + 2]];

      const sorted = Float32Array.from(lum); sorted.sort();
      const q = (p) => sorted[Math.min(n - 1, Math.floor(p * n))];
      let shadow = 0; for (let j = 0; j < n; j++) if (lum[j] < 8 / 255) shadow++;

      // cumulative fraction under each of the bottom 24 code values
      const cum = []; let acc = 0;
      for (let c = 0; c < 24; c++) { acc += hist[c]; cum.push(+(acc / n).toFixed(5)); }

      // darkest 24x24 tile, and a coarse 8x8 map of each tile's 5th percentile
      const TX = 8, TY = 8;
      const tile = [];
      for (let ty = 0; ty < TY; ty++) {
        const row = [];
        for (let tx = 0; tx < TX; tx++) {
          const x0 = Math.floor(tx * W2 / TX), x1 = Math.floor((tx + 1) * W2 / TX);
          const y0 = Math.floor(ty * H2 / TY), y1 = Math.floor((ty + 1) * H2 / TY);
          const v = [];
          for (let yy = y0; yy < y1; yy += 3) for (let xx = x0; xx < x1; xx += 3) v.push(lum[yy * W2 + xx]);
          v.sort((a, b) => a - b);
          row.push(+(v[Math.floor(v.length * 0.05)] * 255).toFixed(1));
        }
        tile.push(row);
      }

      const g = window.game;
      return {
        w: W2, h: H2, mean: sum / n, min, max, minPx: dpx, minRGB: [minR, minG, minB],
        darkAt: [darkI % W2, Math.floor(darkI / W2)],
        shadowFrac: shadow / n,
        p001: q(0.001), p01: q(0.01), p05: q(0.05), p10: q(0.10), p20: q(0.2),
        p50: q(0.5), p90: q(0.9), p99: q(0.99),
        cum, tile,
        state: { flash: g.flash, fade: g.fade, envDim: g.envDim, mode: g.mode, t: g.t,
          hushProx: g.hushProx, speedK: g.speedK, slow: g.slow },
        hdr: (() => { try { return window.LUMEN.hdrStats(); } catch (e) { return String(e); } })(),
      };
    }, arg('set', ''));

    if (DUMP) {
      const b64 = await page.evaluate(() => { window.game.render(1 / 120); return document.getElementById('gl').toDataURL('image/png').split(',')[1]; });
      await writeFile(DUMP, Buffer.from(b64, 'base64'));
    }

    const pc = (x) => (x * 100).toFixed(2) + '%';
    const c8 = (x) => (x * 255).toFixed(2);
    if (argv.includes('--brief')) {
      console.log(`${String(seed).padStart(2)}/${sc.padEnd(9)} ${(QS || 'none').padEnd(22)} fl ${(r.state.flash ?? 0).toFixed(4)} L8 ${pc(r.shadowFrac).padStart(7)}  mean L${c8(r.mean).padStart(6)}  min L${c8(r.min).padStart(6)}  p1 L${c8(r.p01).padStart(6)}  p5 L${c8(r.p05).padStart(6)}  p10 L${c8(r.p10).padStart(6)}  p50 L${c8(r.p50).padStart(6)}  p99 L${c8(r.p99).padStart(6)}  || hdr p50 ${(+r.hdr.p50).toFixed(4)} p90 ${(+r.hdr.p90).toFixed(4)} p99 ${(+r.hdr.p99).toFixed(4)} max ${(+r.hdr.max).toFixed(2)}`);
      continue;
    }
    console.log(`\n=== seed ${seed} / ${sc}  [${QS || 'no kills'}]  ${r.w}x${r.h}  depth=${info?.depth}m  t=${(r.state.t ?? 0).toFixed(3)}s`);
    console.log(`  state  flash=${(r.state.flash ?? 0).toFixed(4)} fade=${(r.state.fade ?? 0).toFixed(4)} envDim=${(r.state.envDim ?? 1).toFixed(4)} mode=${r.state.mode} hushProx=${(r.state.hushProx ?? 0).toFixed(3)}`);
    console.log(`  L8 fraction  ${pc(r.shadowFrac)}      mean ${r.mean.toFixed(4)} (L${c8(r.mean)})   max ${r.max.toFixed(4)}`);
    console.log(`  min L ${c8(r.min)}   darkest pixel rgb=${r.minPx.join(',')} at ${r.darkAt.join(',')}   per-channel frame min rgb=${r.minRGB.join(',')}`);
    console.log(`  low  p0.1=L${c8(r.p001)} p1=L${c8(r.p01)} p5=L${c8(r.p05)} p10=L${c8(r.p10)} p20=L${c8(r.p20)} | p50=L${c8(r.p50)} p90=L${c8(r.p90)} p99=L${c8(r.p99)}`);
    console.log(`  cum%<code: ` + r.cum.map((v, i) => `${i}:${(v * 100).toFixed(2)}`).join(' '));
    console.log(`  hdr   ` + (typeof r.hdr === 'object' ? Object.entries(r.hdr).map(([k, v]) => `${k}=${(+v).toFixed(4)}`).join(' ') : r.hdr));
    console.log(`  tile 5th-pct code values (8x8, top-left to bottom-right):`);
    for (const row of r.tile) console.log('    ' + row.map(v => String(v).padStart(6)).join(''));
    if (errs.length) console.log('  PAGE ERRORS: ' + errs.join(' | '));
  }
  await page.close();
 }
}
await browser.close();
server.close();
