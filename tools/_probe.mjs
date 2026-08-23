#!/usr/bin/env node
/**
 * Scratch level-design probe (owned by the world agent; delete when done).
 *
 *   node tools/_probe.mjs --seeds 3,7,11,19 --secs 90
 *
 * Runs the deterministic autopilot headlessly and reports, per seed:
 *   distance reached, deaths + causes, anchor gap stats, starvation (time with
 *   no anchor in reach), plankton collected, band extremes, anchors in rock.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const SEEDS = String(arg('seeds', '3,7,11,19,23')).split(',').map(Number);
const SECS = Number(arg('secs', 90));

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if ((await stat(file)).isDirectory()) throw 0;
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store', 'Content-Length': body.length });
    res.end(body);
  } catch { res.writeHead(404).end('404'); }
});
await new Promise(r => server.listen(0, r));
const PORT = server.address().port;

const browser = await puppeteer.launch({ headless: true,
  args: ['--no-sandbox', '--hide-scrollbars', '--mute-audio'] });
const page = await browser.newPage();
await page.setViewport({ width: 800, height: 450 });
const errs = [];
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', e => errs.push(String(e && e.message || e)));

const rows = [];
for (const seed of SEEDS) {
  await page.goto(`http://127.0.0.1:${PORT}/?headless=1&seed=${seed}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.LUMEN && window.LUMEN.ready === true', { timeout: 45000, polling: 50 });
  const out = await page.evaluate(async (secs) => {
    const g = window.game;
    const P = g.player.constructor === undefined ? null : null;
    const REACH = 620;
    const FIXED = 1 / 120;
    const steps = Math.round(secs / FIXED);

    let plankton = 0;
    const ob = g.fx.burst;
    g.fx.burst = (x, y, f, m) => { if (f === 'plankton') plankton++; return ob(x, y, f, m); };

    const deaths = [];
    let runs = 0, bestX = 0, sumX = 0;
    let starveT = 0, maxStarve = 0, starveAt = 0, noAnchorSteps = 0, freeSteps = 0;
    let attachedSteps = 0, speedSum = 0, wallSteps = 0;
    let inRock = 0, checkedAnchors = 0;
    let minBand = 1e9, maxBand = -1e9;
    const seen = new Set();

    g.startPlay(); runs = 1;
    let runStart = g.t;
    for (let i = 0; i < steps; i++) {
      const p = g.player, w = g.world;
      if (g.mode === 'dead') {
        deaths.push({ cause: p.deathCause || '?', x: Math.round(p.maxX), t: +(g.t - runStart).toFixed(1) });
        bestX = Math.max(bestX, p.maxX); sumX += p.maxX;
        g.startPlay(); runs++; runStart = g.t;
        continue;
      }
      g.input.setSynthetic(g.autopilot());
      g.step(FIXED);
      g.input.endFrame();

      if (p.alive) {
        speedSum += p.speed;
        if (p.attached) attachedSteps++;
        else {
          freeSteps++;
          let near = false;
          const list = w.anchors;
          for (let k = 0; k < list.length; k++) {
            const a = list[k];
            if (a.x < p.x - 200) continue;
            if (a.x > p.x + REACH + 40) break;
            const dx = a.x - p.x, dy = a.y - p.y;
            if (dx * dx + dy * dy < REACH * REACH) { near = true; break; }
          }
          if (!near) { noAnchorSteps++; starveT += FIXED; if (starveT > maxStarve) { maxStarve = starveT; starveAt = Math.round(p.x); } }
          else starveT = 0;
        }
        const top = w.bandTop(p.x), bot = w.bandBot(p.x);
        const h = bot - top;
        if (h < minBand) minBand = h;
        if (h > maxBand) maxBand = h;
        if (p.y <= top + 16.1 || p.y >= bot - 16.1) wallSteps++;
        for (const a of w.anchors) {
          if (seen.has(a)) continue; seen.add(a);
          checkedAnchors++;
          const t2 = w.bandTop(a.x), b2 = w.bandBot(a.x);
          if (a.y < t2 + a.r * 0.5 || a.y > b2 - a.r * 0.5) inRock++;
        }
      }
    }
    bestX = Math.max(bestX, g.player.maxX);
    sumX += g.player.maxX;

    // anchor gap stats over a long generated stretch
    const w = g.world;
    w.populate(w.genX + 8000);
    const xs = w.anchors.map(a => a.x).sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < xs.length; i++) gaps.push(xs[i] - xs[i - 1]);
    gaps.sort((a, b) => a - b);
    const pct = (q) => gaps.length ? Math.round(gaps[Math.min(gaps.length - 1, Math.floor(q * gaps.length))]) : 0;

    // band profile sweep
    let bMin = 1e9, bMax = -1e9;
    for (let x = 0; x < 46000; x += 40) { const h = w.bandBot(x) - w.bandTop(x); if (h < bMin) bMin = h; if (h > bMax) bMax = h; }

    return {
      runs, deaths, bestX: Math.round(bestX), avgX: Math.round(sumX / runs),
      plankton, maxStarve: +maxStarve.toFixed(2), starveAt,
      starvePct: freeSteps ? Math.round(100 * noAnchorSteps / freeSteps) : 0,
      attachedPct: Math.round(100 * attachedSteps / Math.max(1, attachedSteps + freeSteps)),
      avgSpeed: Math.round(speedSum / Math.max(1, attachedSteps + freeSteps)),
      wallPct: Math.round(100 * wallSteps / Math.max(1, attachedSteps + freeSteps)),
      gapMin: gaps.length ? Math.round(gaps[0]) : 0, gapMed: pct(0.5), gapP90: pct(0.9),
      gapMax: gaps.length ? Math.round(gaps[gaps.length - 1]) : 0,
      nAnchors: xs.length, inRock, checkedAnchors,
      bandMinRun: Math.round(minBand), bandMaxRun: Math.round(maxBand),
      bandMinSweep: Math.round(bMin), bandMaxSweep: Math.round(bMax),
    };
  }, SECS);
  rows.push({ seed, ...out });
}
await browser.close();
server.close();

const causeTally = {};
for (const r of rows) for (const d of r.deaths) causeTally[d.cause] = (causeTally[d.cause] || 0) + 1;

console.log(`\nAUTOPILOT PROBE  ${SECS}s per seed  seeds=${SEEDS.join(',')}`);
console.log('seed  runs  bestM  avgM  plank  atch%  avgV  wall%  starve(s@x)  starve%  gaps min/med/p90/max  band min/max  rock');
for (const r of rows) {
  console.log(
    String(r.seed).padStart(4) +
    String(r.runs).padStart(6) +
    String(Math.round(r.bestX / 10)).padStart(7) +
    String(Math.round(r.avgX / 10)).padStart(6) +
    String(r.plankton).padStart(7) +
    String(r.attachedPct).padStart(7) +
    String(r.avgSpeed).padStart(6) +
    String(r.wallPct).padStart(7) +
    `   ${r.maxStarve}s@${r.starveAt}`.padEnd(15) +
    String(r.starvePct + '%').padStart(8) +
    `   ${r.gapMin}/${r.gapMed}/${r.gapP90}/${r.gapMax}`.padEnd(24) +
    `  ${r.bandMinSweep}/${r.bandMaxSweep}`.padEnd(14) +
    String(r.inRock + '/' + r.checkedAnchors).padStart(8)
  );
}
console.log('\ndeath causes:', JSON.stringify(causeTally));
for (const r of rows) {
  console.log(`  seed ${r.seed}: ` + r.deaths.map(d => `${d.cause}@${Math.round(d.x / 10)}m/${d.t}s`).join(' '));
}
if (errs.length) { console.error('\nPAGE ERRORS:\n' + errs.slice(0, 8).map(e => '  - ' + e).join('\n')); process.exit(1); }
