#!/usr/bin/env node
/**
 * Scratch: why is a prop dark? For every kelp/spire in view at a depth, print
 * distance to the nearest LIVE anchor, whether that anchor is in the light set,
 * the raw _lampAt strength, the depth/dim attenuation, and the warm-rim gate.
 *
 *   node tools/_lamp.mjs --seed 3 --depths 120,400,900
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const SEEDS = String(arg('seeds', '3')).split(',').map(Number);
const DEPTHS = String(arg('depths', '120,400,900')).split(',').map(Number);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8' };
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
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--hide-scrollbars', '--mute-audio'] });

for (const seed of SEEDS) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${PORT}/?headless=1&seed=${seed}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.LUMEN && window.LUMEN.ready === true', { timeout: 45000, polling: 50 });
  for (const dep of DEPTHS) {
    await page.evaluate(async (d) => await window.LUMEN.seekToDepth(d, 240), dep);
    const rows = await page.evaluate(() => {
      const g = window.LUMEN.game, sc = g.scene, cam = g.cam, w = g.world;
      const L = sc._lt, n = sc._lnum;
      const set = [];
      for (let i = 0; i < n; i++) set.push({ x: L[i * 4], y: L[i * 4 + 1], s: L[i * 4 + 2], w: L[i * 4 + 3] });
      const out = [];
      for (const d of w.decor) {
        if (d.kind !== 4) continue;                       // KELP
        if (Math.abs(d.x - cam.x) > cam.viewW * 0.55) continue;
        // nearest LIVE anchor by bulb distance to the strand's midpoint
        const mx = d.x, my = d.y - d.h * 0.55;
        let na = null, nd = 1e18;
        for (const a of w.anchors) {
          if (!a.alive) continue;
          const dd = Math.hypot(a.x - mx, a.y - my);
          if (dd < nd) { nd = dd; na = a; }
        }
        // is that anchor in the light set at nonzero strength?
        let inSet = 0;
        for (const s of set) if (s.w > 0.5 && Math.hypot(s.x - na.x, s.y - na.y) < 1) inSet = s.s;
        const raw = sc._lampAt(mx, my);
        const lamK = raw * (1 - d.depth * 0.72);          // dim=1 in these frames
        out.push({ x: Math.round(d.x), y: Math.round(d.y), h: Math.round(d.h), w: +d.w.toFixed(1),
          dep: +d.depth.toFixed(2), nd: Math.round(nd), ar: Math.round(na.r), inSet: +inSet.toFixed(3),
          bulbW: Math.round(nd / (na.r * 2) * 100) / 100, raw: +raw.toFixed(4), lamK: +lamK.toFixed(4),
          gate: +Math.max(0, Math.min(1, (lamK - 0.02) * 26)).toFixed(3),
          ldx: +sc._ldx.toFixed(2), ldy: +sc._ldy.toFixed(2) });
      }
      return { nlights: n, set: set.map((s) => ({ x: Math.round(s.x), y: Math.round(s.y), s: +s.s.toFixed(3), w: s.w })),
        camx: Math.round(cam.x), viewW: Math.round(cam.viewW),
        anchorsInView: w.anchors.filter((a) => a.alive && Math.abs(a.x - cam.x) < cam.viewW * 0.6).length, rows: out };
    });
    console.log(`\n=== seed ${seed} depth ${dep}m  cam ${rows.camx} viewW ${rows.viewW}  lights ${rows.nlights}  anchors in reach ${rows.anchorsInView}`);
    console.log('  set:', JSON.stringify(rows.set));
    rows.rows.sort((a, b) => a.nd - b.nd);
    for (const r of rows.rows.slice(0, 14)) {
      console.log(`  kelp x=${r.x} h=${r.h} w=${r.w} depth=${r.dep} | nearest anchor r=${r.ar} at ${r.nd}u = ${r.bulbW} bulb-widths, inSet=${r.inSet} | raw=${r.raw} lamK=${r.lamK} gate=${r.gate} dir=(${r.ldx},${r.ldy})`);
    }
    console.log(`  ${rows.rows.length} kelp in view, ${rows.rows.filter((r) => r.gate === 0).length} with the warm rim fully off`);
  }
  await page.close();
}
await browser.close();
server.close();
