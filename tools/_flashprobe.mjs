// Why `tethered` could not reach black. Sweeps the `tethered` predicate's
// holdTime threshold and reports, per seed, the surviving `startPlay()` flash
// against the closed form 0.22*exp(-7.5*runT), plus the luminance and salience
// the frame lands on. Boots the same harness check.mjs uses and samples the
// same 192x108. The point it exists to make: at the old 0.25 the flash is
// identical on every seed, because it is a function of the threshold, not of
// the world. See AI_HANDOFF.md sec 8.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = new URL('..', import.meta.url).pathname;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if ((await stat(f)).isDirectory()) throw 0;
    const b = await readFile(f);
    res.writeHead(200, { 'Content-Type': MIME[extname(f).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store', 'Content-Length': b.length });
    res.end(b);
  } catch { res.writeHead(404).end('404'); }
});
await new Promise(r => server.listen(0, r));
const PORT = server.address().port;
const browser = await puppeteer.launch({ headless: true,
  args: ['--no-sandbox', '--hide-scrollbars', '--mute-audio', '--font-render-hinting=none'] });

const SAMPLE = () => {
  window.game.render(1 / 120);
  const src = document.getElementById('gl');
  const t = document.createElement('canvas');
  t.width = 192; t.height = 108;
  const x = t.getContext('2d', { willReadFrequently: true });
  x.drawImage(src, 0, 0, t.width, t.height);
  const d = x.getImageData(0, 0, t.width, t.height).data;
  const n = t.width * t.height;
  let sum = 0; const vals = new Float32Array(n);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const l = (d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722) / 255;
    vals[j] = l; sum += l;
  }
  let shadow = 0; for (let i = 0; i < n; i++) if (vals[i] < 8 / 255) shadow++;
  const raw = Float32Array.from(vals);
  let contrast = null, moteRank = null;
  try {
    const g = window.game;
    const uv = g.cam.worldToUv(g.player.x, g.player.y);
    const cx = uv[0] * t.width, cy = (1 - uv[1]) * t.height;
    if (cx > 6 && cy > 6 && cx < t.width - 6 && cy < t.height - 6) {
      let core = 0, ring = 0, ringN = 0;
      for (let y = -7; y <= 7; y++) for (let x = -7; x <= 7; x++) {
        const px = Math.round(cx + x), py = Math.round(cy + y);
        if (px < 0 || py < 0 || px >= t.width || py >= t.height) continue;
        const l = raw[py * t.width + px], r = Math.hypot(x, y);
        if (r <= 2) core = Math.max(core, l); else if (r >= 5) { ring += l; ringN++; }
      }
      if (ringN) contrast = core / Math.max(ring / ringN, 1e-3);
    }
    const BX = 24, BY = 14, energy = new Float64Array(BX * BY);
    for (let yy = 0; yy < t.height; yy++) { const by = Math.min(BY - 1, Math.floor(yy * BY / t.height));
      for (let xx = 0; xx < t.width; xx++) { const bx = Math.min(BX - 1, Math.floor(xx * BX / t.width));
        const l = raw[yy * t.width + xx]; energy[by * BX + bx] += l * l; } }
    const mx = Math.floor(uv[0] * BX), my = Math.floor((1 - uv[1]) * BY);
    if (mx >= 0 && my >= 0 && mx < BX && my < BY) {
      const mine = energy[my * BX + mx]; let better = 0;
      for (let i = 0; i < energy.length; i++) if (energy[i] > mine) better++;
      moteRank = better + 1;
    }
  } catch {}
  vals.sort();
  const q = (p) => vals[Math.min(n - 1, Math.floor(p * n))];
  return { mean: sum / n, shadowFrac: shadow / n, p20: q(0.2), p50: q(0.5), p95: q(0.95), contrast, moteRank };
};

const THS = [0.25, 0.55];
const rows = [];
for (const seed of [7, 3]) {
  for (const th of THS) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
    await page.goto(`http://127.0.0.1:${PORT}/?headless=1&seed=${seed}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction('window.LUMEN && window.LUMEN.ready === true', { timeout: 45000, polling: 50 });
    await page.evaluate(() => window.LUMEN.seekTo(0.001));           // same as check.mjs `title`
    const info = await page.evaluate(async (TH) => {
      const g = window.game, FIXED = 1 / 120;
      if (g.mode === 'title') g.startPlay();
      const limit = g.t + 60; let guard = 0;
      while (g.t < limit && guard++ < 400000) {
        if (g.mode === 'dead' && g.deadT > 1.2) g.startPlay();
        g.input.setSynthetic(g.autopilot());
        g.step(FIXED);
        g.input.endFrame();
        if (g.player.attached && g.player.holdTime > TH) break;
      }
      await new Promise((res) => requestAnimationFrame(() => { g.render(FIXED); requestAnimationFrame(() => res()); }));
      const s = g.stats();
      return { flash: g.flash, holdTime: g.player.holdTime, depth: s.depth, simT: g.t, runT: g.runT, attachT: g.runT - g.player.holdTime, pred: 0.22 * Math.exp(-7.5 * g.runT) };
    }, th);
    const lum = await page.evaluate(SAMPLE);
    rows.push({ seed, th, ...info, ...lum });
    await page.close();
  }
}
console.log('seed  th    flash     0.22*exp(-7.5*runT)  runT    hold    attachedAt');
for (const r of rows) {
  console.log(`${String(r.seed).padEnd(5)} ${r.th.toFixed(2)}  ${r.flash.toFixed(5)}   ${r.pred.toFixed(5)}              ${r.runT.toFixed(4)}  ${r.holdTime.toFixed(4)}   t=${r.attachT.toFixed(4)}s`);
}
await browser.close(); server.close();
