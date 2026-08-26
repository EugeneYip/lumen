#!/usr/bin/env node
/**
 * _vs.mjs -- VALUE STRUCTURE probe for background.js.
 *
 * Segments the frame by which terrain layer is drawn at each pixel (near rock,
 * far wall 1..4, open water), then reports the DELIVERED luminance of each,
 * and decomposes it by ablating one term at a time.
 *
 *   node tools/_vs.mjs --seeds 7,3 --scenes title,tethered,launch,fast,hushNear,hazardNear
 *   node tools/_vs.mjs --seeds 7 --scenes fast --decomp
 *
 * Requires the instrumented background.js (uAbl/uAbl2/uAbl3/uAbl4 uniforms).
 * SCRATCH INSTRUMENT -- not part of the gate.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const SEEDS = String(arg('seeds', '7,3')).split(',').map(Number);
const SCENES = String(arg('scenes', 'title,tethered,launch,fast,hushNear,hazardNear')).split(',');
const W = Number(arg('w', 1600)), H = Number(arg('h', 900));
const DECOMP = argv.includes('--decomp');
const JSONOUT = argv.includes('--json');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.png': 'image/png', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if ((await stat(file)).isDirectory()) throw 0;
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404).end('404'); }
});
await new Promise((r) => server.listen(0, r));
const PORT = server.address().port;

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--hide-scrollbars', '--mute-audio', '--force-device-scale-factor=1'],
});

const out = [];
for (const seed of SEEDS) {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push(String(e && e.message || e)));
  await page.goto(`http://127.0.0.1:${PORT}/?headless=1&seed=${seed}&noSprites=1&noRibbons=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.LUMEN && window.LUMEN.ready === true', { timeout: 45000, polling: 50 });

  for (const sc of SCENES) {
    const info = sc === 'title'
      ? await page.evaluate(() => window.LUMEN.seekTo(0.001))
      : await page.evaluate((c) => window.LUMEN.seekUntil(c, 60), sc);

    const r = await page.evaluate((decomp) => {
      const g = window.game, gl = g.gl, rt = g.post.scene, bg = g.bg;
      const ctx = g.frameCtx(1 / 60);
      const Wp = rt.w, Hp = rt.h, N = Wp * Hp;
      const buf = new Float32Array(N * 4);
      const drawRead = () => {
        rt.bind(true);
        bg.draw(ctx);
        gl.readPixels(0, 0, Wp, Hp, gl.RGBA, gl.FLOAT, buf);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return buf;
      };
      const set = (a, a2, a3, a4) => {
        bg.abl.set(a); bg.abl2.set(a2); bg.abl3.set(a3); bg.abl4.set(a4);
      };
      const ONE = [1, 1, 1, 1];

      // --- layer id map -----------------------------------------------------
      set(ONE, ONE, ONE, [1, 1, 1, 1]);
      drawRead();
      const id = new Uint8Array(N);
      const skyv = new Float32Array(N);
      for (let i = 0, j = 0; i < N; i++, j += 4) { id[i] = Math.round(buf[j]); skyv[i] = buf[j + 2]; }

      // Drop pixels adjacent to a layer boundary: coverage is antialiased there
      // and a mixed pixel belongs to neither layer.
      const keep = new Uint8Array(N);
      for (let y = 1; y < Hp - 1; y++) for (let x = 1; x < Wp - 1; x++) {
        const i = y * Wp + x;
        const v = id[i];
        keep[i] = (id[i - 1] === v && id[i + 1] === v && id[i - Wp] === v && id[i + Wp] === v) ? 1 : 0;
      }

      const LUM = (j) => buf[j] * 0.2126 + buf[j + 1] * 0.7152 + buf[j + 2] * 0.0722;
      const stat = () => {
        const sum = new Float64Array(6), cnt = new Float64Array(6);
        const bins = [];
        for (let k = 0; k < 6; k++) bins.push(new Int32Array(1024));
        for (let i = 0, j = 0; i < N; i++, j += 4) {
          if (!keep[i]) continue;
          const L = LUM(j), k = id[i];
          sum[k] += L; cnt[k]++;
          let b = Math.floor((Math.log2(Math.max(L, 1e-9)) + 20) / 28 * 1024);
          if (b < 0) b = 0; else if (b > 1023) b = 1023;
          bins[k][b]++;
        }
        const res = [];
        for (let k = 0; k < 6; k++) {
          const n = cnt[k];
          let med = 0;
          if (n > 0) {
            let acc = 0;
            for (let b = 0; b < 1024; b++) { acc += bins[k][b]; if (acc >= n * 0.5) { med = Math.pow(2, (b + 0.5) / 1024 * 28 - 20); break; } }
          }
          res.push({ n, frac: n / N, mean: n ? sum[k] / n : 0, med });
        }
        return res;
      };

      // --- baseline ---------------------------------------------------------
      set(ONE, ONE, ONE, [1, 1, 1, 0]);
      drawRead();
      const base = stat();

      const decompRes = {};
      if (decomp) {
        const cfgs = {
          noGlow:     [[0, 1, 1, 1], ONE, ONE, [1, 1, 1, 0]],
          noFog:      [[1, 0, 1, 1], ONE, ONE, [1, 1, 1, 0]],
          noAw:       [[1, 1, 0, 1], ONE, ONE, [1, 1, 1, 0]],
          noRim:      [[1, 1, 1, 0], ONE, ONE, [1, 1, 1, 0]],
          noSkyBody:  [ONE, [0, 1, 1, 1], ONE, [1, 1, 1, 0]],
          noVeil:     [ONE, [1, 0, 1, 1], ONE, [1, 1, 1, 0]],
          noSeam:     [ONE, [1, 1, 0, 1], ONE, [1, 1, 1, 0]],
          noMoteLamp: [ONE, [1, 1, 1, 0], ONE, [1, 1, 1, 0]],
          nrNoSky:    [ONE, ONE, [0, 1, 1, 1], [1, 1, 1, 0]],
          nrNoAmb:    [ONE, ONE, [1, 0, 1, 1], [1, 1, 1, 0]],
          nrNoGlow:   [ONE, ONE, [1, 1, 0, 1], [1, 1, 1, 0]],
          nrNoLampKey:[ONE, ONE, [1, 1, 1, 0], [1, 1, 1, 0]],
          nrNoRim:    [ONE, ONE, ONE, [0, 1, 1, 0]],
        };
        for (const k of Object.keys(cfgs)) {
          set(...cfgs[k]);
          drawRead();
          decompRes[k] = stat().map((s) => s.mean);
        }
      }
      set(ONE, ONE, ONE, [1, 1, 1, 0]);

      // --- display-domain: full graded frame, same frozen state -------------
      g.render(1 / 60);
      const src = document.getElementById('gl');
      const f = document.createElement('canvas');
      f.width = src.width; f.height = src.height;
      const fx = f.getContext('2d', { willReadFrequently: true });
      fx.drawImage(src, 0, 0);
      const fd = fx.getImageData(0, 0, f.width, f.height).data;
      // canvas rows run top-down, the GL read ran bottom-up
      const dsum = new Float64Array(6), dcnt = new Float64Array(6);
      const dbin = []; for (let k = 0; k < 6; k++) dbin.push(new Int32Array(256));
      for (let y = 0; y < Hp; y++) for (let x = 0; x < Wp; x++) {
        const i = y * Wp + x;
        if (!keep[i]) continue;
        const jj = ((Hp - 1 - y) * Wp + x) * 4;
        const L = (fd[jj] * 0.2126 + fd[jj + 1] * 0.7152 + fd[jj + 2] * 0.0722) / 255;
        const k = id[i];
        dsum[k] += L; dcnt[k]++;
        dbin[k][Math.min(255, Math.round(L * 255))]++;
      }
      const disp = [];
      for (let k = 0; k < 6; k++) {
        const n = dcnt[k];
        let med = 0;
        if (n) { let acc = 0; for (let b = 0; b < 256; b++) { acc += dbin[k][b]; if (acc >= n * 0.5) { med = b / 255; break; } } }
        disp.push({ n, mean: n ? dsum[k] / n : 0, med });
      }
      // mean sky over each layer, as a diagnostic on the light field
      const ssum = new Float64Array(6), scnt = new Float64Array(6);
      for (let i = 0; i < N; i++) { if (!keep[i]) continue; ssum[id[i]] += skyv[i]; scnt[id[i]]++; }
      const sky = []; for (let k = 0; k < 6; k++) sky.push(scnt[k] ? ssum[k] / scnt[k] : 0);

      return { base, disp, decomp: decompRes, sky, w: Wp, h: Hp };
    }, DECOMP);

    out.push({ seed, scene: sc, depth: info?.depth, ...r });
  }
  await page.close();
  if (errs.length) console.error('console errors seed ' + seed + ': ' + errs.slice(0, 3).join(' | '));
}
await browser.close();
server.close();

const NAMES = ['water', 'far4(s.135)', 'far3(s.225)', 'far2(s.360)', 'far1(s.580)', 'nearRock'];
if (JSONOUT) { console.log(JSON.stringify(out, null, 1)); process.exit(0); }
for (const r of out) {
  console.log(`\n=== seed ${r.seed} / ${r.scene}  ${r.depth ?? ''}m   (${r.w}x${r.h}) ===`);
  console.log('  layer          area%    HDRmean     HDRmed     dispMean  dispMed   sky');
  for (let k = 0; k < 6; k++) {
    const b = r.base[k], d = r.disp[k];
    console.log(`  ${NAMES[k].padEnd(13)} ${(b.frac * 100).toFixed(2).padStart(6)}  ${b.mean.toFixed(5).padStart(9)}  ${b.med.toFixed(5).padStart(9)}  ${d.mean.toFixed(4).padStart(8)}  ${d.med.toFixed(4).padStart(7)}  ${r.sky[k].toFixed(3)}`);
  }
  if (Object.keys(r.decomp).length) {
    console.log('  --- ablation: HDR mean per layer, and % of baseline removed ---');
    for (const k of Object.keys(r.decomp)) {
      const row = r.decomp[k];
      const pct = row.map((v, i) => {
        const b = r.base[i].mean;
        return b > 0 ? (((b - v) / b) * 100).toFixed(1).padStart(7) : '     --';
      });
      console.log(`  ${k.padEnd(12)} ${pct.join(' ')}`);
    }
    console.log(`  ${''.padEnd(12)} ${NAMES.map((n) => n.slice(0, 7).padStart(7)).join(' ')}`);
  }
}
