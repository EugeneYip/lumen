#!/usr/bin/env node
/**
 * Scratch reachability audit (owned by the world agent).
 *
 *   node tools/_reach.mjs --seeds 3,7,11 --upto 40000
 *
 * Does NOT use world.js's internal arc model. It imports the real Player class
 * and drives real physics: from each anchor, swing and release across a sweep of
 * hold times and ask whether ANY anchor ahead ever comes inside P.reach. An
 * anchor from which no release reaches anything is a dead end, i.e. an unfair
 * death, and is exactly what the design-time arc is supposed to make impossible.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const SEEDS = String(arg('seeds', '3,7,11')).split(',').map(Number);
const UPTO = Number(arg('upto', 40000));

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' };
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if ((await stat(f)).isDirectory()) throw 0;
    const b = await readFile(f);
    res.writeHead(200, { 'Content-Type': MIME[extname(f).toLowerCase()] || 'application/octet-stream', 'Content-Length': b.length });
    res.end(b);
  } catch { res.writeHead(404).end('404'); }
});
await new Promise(r => server.listen(0, r));
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--mute-audio'] });
const rows = [];
for (const seed of SEEDS) {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/?headless=1&seed=${seed}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.LUMEN && window.LUMEN.ready === true', { timeout: 45000, polling: 50 });
  rows.push({ seed, ...await page.evaluate(async (upto) => {
    const mod = await import('/src/game/player.js');
    const { Player, P } = mod;
    const w = window.game.world;
    w.populate(upto + 4000);
    const anchors = w.anchors.slice().sort((a, b) => a.x - b.x).filter(a => a.x > 0 && a.x < upto);

    const noop = () => {};
    const fx = { sparks: noop, burst: noop, ring: noop, bubbles: noop, shake: noop,
      flash: noop, slowmo: noop, wave: noop, sound: noop };
    const stub = {
      bandTop: (x) => w.bandTop(x), bandBot: (x) => w.bandBot(x),
      plankton: [], hazards: [], anchors: w.anchors, hushX: -1e9,
      pickAnchor: () => null,
    };
    const input = { held: true };
    const DT = 1 / 120;

    // Nearest anchor strictly ahead of `fromX`, excluding the one we launched from.
    const nearestAhead = (px, py, fromA) => {
      let best = 1e9;
      for (let i = 0; i < anchors.length; i++) {
        const a = anchors[i];
        if (a === fromA) continue;
        if (a.x <= fromA.x + 40) continue;
        if (a.x < px - 700) continue;
        if (a.x > px + 900) break;
        const d = Math.hypot(a.x - px, a.y - py);
        if (d < best) best = d;
      }
      return best;
    };

    const p = new Player();
    /** Best (smallest) distance to any anchor ahead, over one hold time. */
    const tryHold = (A, hold) => {
      p.reset();
      // arrive from behind and below, swinging forward - a normal approach
      const rope0 = Math.min(P.ropeMax, 500);
      p.x = A.x - 0.35 * rope0; p.y = A.y + 0.94 * rope0;
      p.vx = 0.94 * 820; p.vy = 0.35 * 820;
      p.anchor = A; p.rope = rope0; p.holdTime = 0; p.sinceRelease = 99;
      let best = 1e9;
      const nHold = Math.round(hold / DT), nFly = Math.round(2.6 / DT);
      input.held = true;
      for (let i = 0; i < nHold; i++) {
        p.update(DT, stub, input, fx, i * DT);
        if (!p.alive) return 1e9;
      }
      input.held = false;
      for (let i = 0; i < nFly; i++) {
        p.update(DT, stub, input, fx, (nHold + i) * DT);
        if (!p.alive) break;
        const d = nearestAhead(p.x, p.y, A);
        if (d < best) best = d;
        if (best < P.reach * 0.9) break;
        if (p.x > A.x + 2600) break;
      }
      return best;
    };

    let dead = 0, near = 0;
    const worst = [];
    let sumBest = 0, n = 0;
    for (const A of anchors) {
      let best = 1e9;
      for (let h = 0.12; h <= 1.85; h += 0.11) {
        const d = tryHold(A, h);
        if (d < best) best = d;
        if (best < P.reach * 0.75) break;      // comfortably reachable, stop sweeping
      }
      n++; sumBest += Math.min(best, 2000);
      if (best > P.reach) {
        const t2 = w.bandTop(A.x), b2 = w.bandBot(A.x);
        dead++;
        worst.push({ x: Math.round(A.x), d: Math.round(best),
          fr: +((A.y - t2) / (b2 - t2)).toFixed(2), low: !!A.low,
          kind: w._phraseAt(A.x).kind });
      }
      else if (best > P.reach * 0.92) near++;
    }
    worst.sort((a, b) => b.d - a.d);
    return { anchors: n, dead, near, avgBest: Math.round(sumBest / Math.max(1, n)),
      worst: worst.slice(0, 6), reach: P.reach };
  }, UPTO) });
  await page.close();
}
await browser.close(); server.close();

console.log(`\nREACHABILITY (real Player physics, hold-time sweep)   reach=${rows[0].reach}`);
console.log('seed   anchors   dead-ends   near-misses   avg best-distance');
for (const r of rows) {
  console.log(String(r.seed).padStart(4) + String(r.anchors).padStart(10) +
    String(r.dead).padStart(12) + String(r.near).padStart(14) + String(r.avgBest).padStart(20));
}
for (const r of rows) {
  if (r.worst.length) console.log(`  seed ${r.seed} worst: ` + r.worst.map(w => `x${w.x} d${w.d} frac${w.fr}${w.low ? ' LOW' : ''} ${w.kind}`).join(' | '));
}
