#!/usr/bin/env node
/**
 * Scratch probe (owned by the environment agent; delete when done).
 * Reads a full-resolution HDR scanline straight out of post.scene, with the ray
 * pass on and off, so the god-ray contribution can be measured as a signal
 * rather than eyeballed through the grade.
 *
 *   node tools/_shaft.mjs --seed 3 --scene deep --row 0.5
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import puppeteer from 'puppeteer';
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const SEED = Number(arg('seed', 3)), SCENE = arg('scene', 'deep');
const ROWS = String(arg('row', '0.30,0.50,0.70')).split(',').map(Number);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try { let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if ((await stat(f)).isDirectory()) throw 0;
    const b = await readFile(f);
    res.writeHead(200, { 'Content-Type': MIME[extname(f).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store' }); res.end(b);
  } catch { res.writeHead(404).end('404'); }
});
await new Promise(r => server.listen(0, r));
const PORT = server.address().port;
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--hide-scrollbars', '--mute-audio'] });

async function scan(extra) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  await page.goto(`http://127.0.0.1:${PORT}/?headless=1&seed=${SEED}${extra}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.LUMEN && window.LUMEN.ready === true', { timeout: 45000, polling: 50 });
  const info = SCENE === 'title' ? await page.evaluate(() => window.LUMEN.seekTo(0.001))
                                 : await page.evaluate(c => window.LUMEN.seekUntil(c, 60), SCENE);
  const out = await page.evaluate((rows) => {
    const g = window.LUMEN.game, gl = g.gl, rt = g.post.scene;
    g.render(1 / 60);
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt.fbo);
    const buf = new Float32Array(rt.w * 4);
    const res = [];
    for (const fr of rows) {
      const y = Math.min(rt.h - 1, Math.max(0, Math.round(fr * rt.h)));
      gl.readPixels(0, y, rt.w, 1, gl.RGBA, gl.FLOAT, buf);
      const lum = new Array(rt.w);
      for (let x = 0; x < rt.w; x++)
        lum[x] = buf[x * 4] * 0.2126 + buf[x * 4 + 1] * 0.7152 + buf[x * 4 + 2] * 0.0722;
      res.push(lum);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { w: rt.w, h: rt.h, rows: res, view: [g.cam.viewW, g.cam.viewH] };
  }, ROWS);
  await page.close();
  return { ...out, info };
}
const on = await scan('&bgNoHush=1');
const off = await scan('&bgNoHush=1&bgNoRays=1');
await browser.close(); server.close();

const wpx = on.view[0] / on.w;
console.log(`seed ${SEED} scene ${SCENE}  ${on.w}x${on.h}  view ${on.view.map(v=>v.toFixed(0))}  ${wpx.toFixed(2)} world units/px`);
for (let r = 0; r < ROWS.length; r++) {
  const a = on.rows[r], b = off.rows[r], n = a.length;
  const d = a.map((v, i) => v - b[i]);              // the ray pass, isolated
  const stat = (v) => { const s = [...v].sort((p, q) => p - q);
    return { mean: v.reduce((p, q) => p + q, 0) / n, p50: s[n >> 1], p99: s[Math.floor(n * 0.99)], max: s[n - 1] }; };
  const sd = stat(d);
  // second difference: a crease in a piecewise-linear field spikes here
  let d2max = 0, d2sum = 0, d2at = 0, above = 0;
  for (let i = 80; i < n - 80; i++) {
    const v = Math.abs(2 * d[i] - d[i - 2] - d[i + 2]);
    d2sum += v; if (v > d2max) { d2max = v; d2at = i; }
  }
  for (let i = 80; i < n - 80; i++) if (d[i] > 0.02) above++;
  console.log(`row ${ROWS[r]}: rays mean=${sd.mean.toFixed(4)} p50=${sd.p50.toFixed(4)} p99=${sd.p99.toFixed(4)} max=${sd.max.toFixed(4)}`
    + `  cover(>0.02)=${(above / (n - 160) * 100).toFixed(1)}%  |d2| mean=${(d2sum / (n - 160)).toExponential(2)} max=${d2max.toFixed(4)} @x=${d2at}`);
  const spikes = [];
  for (let i = 80; i < n - 80; i++) spikes.push({ i, v: Math.abs(2 * d[i] - d[i - 2] - d[i + 2]) });
  spikes.sort((p, q) => q.v - p.v);
  const picked = [];
  for (const s of spikes) { if (picked.every(q => Math.abs(q.i - s.i) > 12)) picked.push(s); if (picked.length === 6) break; }
  for (const s of picked)
    console.log(`     spike x=${String(s.i).padStart(4)} |d2|=${s.v.toFixed(4)}  ` +
      [-4,-3,-2,-1,0,1,2,3,4].map(k => (d[s.i + k] ?? 0).toFixed(3)).join(' '));
  // print the field coarsely so its shape is legible
  const step = Math.floor(n / 80);
  console.log('   ' + Array.from({ length: 80 }, (_, i) => {
    const v = d[i * step]; return v > 0.30 ? '#' : v > 0.15 ? '+' : v > 0.05 ? ':' : v > 0.015 ? '.' : ' ';
  }).join(''));
}
