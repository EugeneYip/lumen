#!/usr/bin/env node
/**
 * TEMPORARY feel-measurement harness (physics agent scratch; delete when done).
 *
 *   node tools/_feel.mjs --mode run   --seeds 3,7,11,19 --secs 60
 *   node tools/_feel.mjs --mode skill
 *   node tools/_feel.mjs --mode pump
 *
 * run   : drives the deterministic autopilot, reports distance/speed/attach/deaths.
 * skill : controlled release-angle sweep -> does release TIMING pay off?
 * pump  : does holding + reeling actually add energy, and can it be sustained?
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const MODE = arg('mode', 'run');
const SEEDS = String(arg('seeds', '3,7,11,19')).split(',').map(Number);
const SECS = Number(arg('secs', 60));

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png' };
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
await new Promise(r => server.listen(0, r));
const PORT = server.address().port;

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--mute-audio', '--hide-scrollbars'] });
const problems = [];

// ---------------------------------------------------------------- in-page ----
// Injected into the page. Uses only the public surface of main.js.
const PAGE = {
  /** Strict fx stub: throws if player.js calls anything main.js does not provide. */
  mkFx: `(() => {
    const real = ['sparks','burst','ring','bubbles','shake','flash','slowmo','wave','sound'];
    const base = {}; for (const k of real) base[k] = () => {};
    return new Proxy(base, { get(t, k) {
      if (k in t) return t[k];
      throw new Error('player.js called fx.' + String(k) + ' which main.js _makeFx does NOT provide');
    }});
  })()`,
};

async function newPage(seed) {
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 450 });
  const IGNORE = /favicon|Failed to load resource/i;
  page.on('console', m => { if (m.type() === 'error' && !IGNORE.test(m.text())) problems.push(`seed${seed} console: ${m.text()}`); });
  page.on('pageerror', e => problems.push(`seed${seed} pageerror: ${(e && e.message) || e}`));
  await page.goto(`http://127.0.0.1:${PORT}/?headless=1&seed=${seed}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction('window.LUMEN && window.LUMEN.ready === true', { timeout: 45000, polling: 50 });
  return page;
}

const pct = (arr, q) => { if (!arr.length) return 0; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.max(0, Math.round(q * (a.length - 1))))]; };
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const f1 = (x) => (Math.round(x * 10) / 10).toFixed(1);

// ------------------------------------------------------------------- run ----
async function runAutopilot(seed) {
  const page = await newPage(seed);
  const r = await page.evaluate(async (secs) => {
    const g = window.game, FIXED = 1 / 120;
    g.startPlay();
    const steps = Math.round(secs / FIXED);
    const speeds = [], deaths = [], distSeries = [];
    let attachedSteps = 0, stallSteps = 0, releases = 0, wasAttached = false, runs = 1;
    let lastX = g.player.x, stuckSteps = 0, maxHushLag = 0, minHushLag = 1e9;
    for (let i = 0; i < steps; i++) {
      g.input.setSynthetic(g.autopilot());
      g.step(FIXED);
      g.input.endFrame();
      const p = g.player;
      if (g.mode === 'dead') {
        deaths.push({ cause: p.deathCause || '?', t: +(i * FIXED).toFixed(2), d: Math.round(p.maxX / 10), v: Math.round(p.speed) });
        g.startPlay(); runs++; lastX = g.player.x; wasAttached = false;
        continue;
      }
      speeds.push(p.speed);
      if (p.attached) attachedSteps++;
      if (wasAttached && !p.attached) releases++;
      wasAttached = p.attached;
      if (p.speed < 220) stallSteps++;
      if (p.x - lastX < 0.05) stuckSteps++; else stuckSteps = 0;
      lastX = p.x;
      const lag = p.x - g.world.hushX;
      if (lag > maxHushLag) maxHushLag = lag;
      if (lag < minHushLag) minHushLag = lag;
      if (i % 600 === 0) distSeries.push(Math.round(p.maxX / 10));
    }
    return {
      seed: g.seed, runs, deaths,
      finalDist: Math.round(g.player.maxX / 10),
      distSeries, speeds, releases,
      attachFrac: attachedSteps / Math.max(1, speeds.length),
      stallFrac: stallSteps / Math.max(1, speeds.length),
      worstStuck: stuckSteps,
      maxHushLag: Math.round(maxHushLag), minHushLag: Math.round(minHushLag),
    };
  }, SECS);
  await page.close();
  return r;
}

// ----------------------------------------------------------------- skill ----
/**
 * Controlled probe. Identical initial pendulum every time; the ONLY difference
 * is the rope angle at which we let go. If payoff is flat across angles, then
 * "when do I release" is not a skill and the core of the game is broken.
 */
async function runSkill(seed) {
  const page = await newPage(seed);
  const r = await page.evaluate(async (fxSrc) => {
    const g = window.game, FIXED = 1 / 120;
    const P = g.player.constructor === undefined ? null : null;
    const fx = eval(fxSrc);
    g.startPlay();
    const w = g.world;
    // isolate the pendulum: no pickups, no hazards, no Hush
    w.plankton.length = 0; w.hazards.length = 0; w.hushX = -1e9;

    const probe = (releaseDeg, holdExtra = 0) => {
      const p = g.player;
      p.reset();
      p.x = 0; p.y = 0; p.vx = 820; p.vy = 60;
      const a = { kind: 0, x: 0, y: -420, r: 24, used: 0, alive: true, big: false };
      p.anchor = a; p.rope = 420; p.holdTime = 0; p.sinceRelease = 0;
      const target = releaseDeg * Math.PI / 180;
      let released = false, relSpeed = 0, relX = 0, relY = 0, held = 0, apex = 0;
      let maxV = 0;
      for (let i = 0; i < 900; i++) {          // 7.5 s cap
        if (!released) {
          // rope angle measured from straight-down, positive = ahead of anchor
          const phi = Math.atan2(p.x - a.x, p.y - a.y);
          const moving = (p.vx * -(p.y - a.y) + p.vy * (p.x - a.x)) > 0;
          if (moving && phi >= target && p.holdTime > 0.05) {
            p.release(fx);
            released = true; relSpeed = p.speed; relX = p.x; relY = p.y; held = p.holdTime;
          }
        }
        p.update(FIXED, w, { held: !released }, fx, i * FIXED);
        if (p.speed > maxV) maxV = p.speed;
        if (released) { apex = Math.min(apex, p.y - relY); }
        if (released && (i * FIXED) > 900) break;
        if (!p.alive) break;
        if (released) { held = held; }
        if (released && p.sinceRelease > 3.0) break;
      }
      return {
        deg: releaseDeg,
        dx: Math.round(p.x - relX),          // ground gained in 3 s of free flight
        relSpeed: Math.round(relSpeed),
        endSpeed: Math.round(p.speed),
        maxV: Math.round(maxV),
        rise: Math.round(-apex),             // how much height the launch bought
        alive: p.alive,
      };
    };

    const out = [];
    for (let d = -30; d <= 85; d += 5) out.push(probe(d));
    return out;
  }, PAGE.mkFx);
  await page.close();
  return r;
}

// ------------------------------------------------------------------ pump ----
async function runPump(seed) {
  const page = await newPage(seed);
  const r = await page.evaluate(async (fxSrc) => {
    const g = window.game, FIXED = 1 / 120;
    const fx = eval(fxSrc);
    g.startPlay();
    const w = g.world;
    w.plankton.length = 0; w.hazards.length = 0; w.hushX = -1e9;
    const p = g.player;
    p.reset(); p.x = 0; p.y = 0; p.vx = 500; p.vy = 0;
    const a = { kind: 0, x: 0, y: -460, r: 24, used: 0, alive: true, big: false };
    p.anchor = a; p.rope = 460; p.holdTime = 0;
    const samples = [];
    for (let i = 0; i < 120 * 6; i++) {
      p.update(FIXED, w, { held: true }, fx, i * FIXED);
      if (i % 30 === 0) samples.push({ t: +(i * FIXED).toFixed(2), v: Math.round(p.speed), rope: Math.round(p.rope), spin: +p.spin.toFixed(2) });
      if (!p.alive) break;
    }
    return samples;
  }, PAGE.mkFx);
  await page.close();
  return r;
}

// ------------------------------------------------------------------- main ----
try {
  if (MODE === 'run') {
    console.log(`autopilot  ${SECS}s per seed\n`);
    const rows = [];
    for (const s of SEEDS) rows.push(await runAutopilot(s));
    console.log('seed  dist(m)  runs deaths            v:p10/p50/p90/max      att%  stall%  hushLag(min/max)');
    for (const r of rows) {
      const causes = {};
      for (const d of r.deaths) causes[d.cause] = (causes[d.cause] || 0) + 1;
      const cs = Object.entries(causes).map(([k, v]) => `${k}x${v}`).join(' ') || 'none';
      console.log(
        `${String(r.seed).padEnd(5)} ${String(r.finalDist).padStart(6)}  ${String(r.runs).padStart(4)} ${cs.padEnd(18)}` +
        `${String(Math.round(pct(r.speeds, 0.10))).padStart(5)}/${String(Math.round(pct(r.speeds, 0.5))).padStart(4)}/${String(Math.round(pct(r.speeds, 0.9))).padStart(4)}/${String(Math.round(Math.max(...r.speeds))).padStart(4)}` +
        `   ${f1(r.attachFrac * 100).padStart(5)}  ${f1(r.stallFrac * 100).padStart(5)}   ${String(r.minHushLag).padStart(6)}/${String(r.maxHushLag).padStart(5)}` +
        `${r.worstStuck > 120 ? '  STUCK!' : ''}`
      );
    }
    const all = rows.flatMap(r => r.speeds);
    console.log(`\nall seeds: mean v=${Math.round(mean(all))}  p50=${Math.round(pct(all, 0.5))}  deaths=${rows.reduce((s, r) => s + r.deaths.length, 0)}  releases=${rows.reduce((s, r) => s + r.releases, 0)}`);
    console.log(`dist over time (every 5s), seed ${rows[0].seed}: ${rows[0].distSeries.join(' ')}`);
  } else if (MODE === 'skill') {
    const rows = await runSkill(SEEDS[0]);
    console.log('release-angle sweep (rope angle from straight-down, + = ahead of anchor)');
    console.log(' deg   dx(3s)  relV  maxV  endV  rise   payoff');
    const base = rows.find(r => r.deg === 0) || rows[0];
    const best = rows.reduce((b, r) => (r.dx > b.dx ? r : b), rows[0]);
    for (const r of rows) {
      const rel = r.dx / Math.max(1, best.dx);
      const bar = '#'.repeat(Math.max(0, Math.round(rel * 40)));
      console.log(`${String(r.deg).padStart(4)} ${String(r.dx).padStart(8)} ${String(r.relSpeed).padStart(5)} ${String(r.maxV).padStart(5)} ${String(r.endSpeed).padStart(5)} ${String(r.rise).padStart(5)}   ${bar}${r.deg === best.deg ? ' <= best' : ''}`);
    }
    const within5 = rows.filter(r => r.dx > best.dx * 0.95).length;
    console.log(`\nbest ${best.deg}deg dx=${best.dx}. sloppy(0deg) dx=${base.dx}. advantage=${f1((best.dx / Math.max(1, base.dx) - 1) * 100)}%`);
    console.log(`sweet spot width (>=95% of best): ${within5} of ${rows.length} samples (${within5 * 5}deg)`);
    const worst = rows.reduce((b, r) => (r.dx < b.dx ? r : b), rows[0]);
    console.log(`worst ${worst.deg}deg dx=${worst.dx} -> best/worst spread = ${f1(best.dx / Math.max(1, worst.dx))}x`);
  } else if (MODE === 'pump') {
    const rows = await runPump(SEEDS[0]);
    console.log('sustained hold + reel (does pumping add energy?)');
    console.log('   t    v  rope  spin');
    for (const r of rows) console.log(`${String(r.t).padStart(5)} ${String(r.v).padStart(4)} ${String(r.rope).padStart(5)} ${String(r.spin).padStart(6)}`);
  }
} finally {
  await browser.close();
  server.close();
}

if (problems.length) { console.error('\nPROBLEMS:\n' + problems.map(p => '  - ' + p).join('\n')); process.exit(1); }
