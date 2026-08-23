#!/usr/bin/env node
/**
 * TEMPORARY feel-measurement harness (physics agent scratch; delete when done).
 *
 *   node tools/_feel.mjs --mode run    --seeds 3,7,11,19 --secs 60
 *   node tools/_feel.mjs --mode skill  --seeds 7
 *   node tools/_feel.mjs --mode policy --seeds 7,3
 *   node tools/_feel.mjs --mode pump
 *   node tools/_feel.mjs --mode rescue
 *
 * run    : deterministic autopilot; distance/speed/attach/deaths/stalls.
 * skill  : release-angle sweep -> does release TIMING pay off, and how much?
 * policy : good vs sloppy vs mashing vs clinging over a long run.
 * pump   : does holding + reeling add energy, and can it be sustained?
 * rescue : dropped on the trench floor at zero speed - can it get back to play?
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

/** Strict fx stub: throws if player.js calls anything main.js does not provide. */
const FX_SRC = `(() => {
  const real = ['sparks','burst','ring','bubbles','shake','flash','slowmo','wave','sound'];
  const base = {}; for (const k of real) base[k] = () => {};
  return new Proxy(base, { get(t, k) {
    if (k in t) return t[k];
    throw new Error('player.js called fx.' + String(k) + ' which main.js _makeFx does NOT provide');
  }});
})()`;

/** Shared in-page helpers: pendulum rig + rope-angle convention. */
const RIG_SRC = `({
  // rope angle from straight-down; + = ahead of the anchor in +x
  phi: (p, a) => Math.atan2(p.x - a.x, p.y - a.y),
  // sign of dphi/dt: are we swinging toward +phi right now?
  rising: (p, a) => {
    const rx = p.x - a.x, ry = p.y - a.y;
    return (ry * p.vx - rx * p.vy) > 0;
  },
  // clear the world so only the pendulum is under test
  clear: (w) => { w.plankton.length = 0; w.hazards.length = 0; w.hushX = -1e9; },
})`;

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
const pad = (x, n) => String(x).padStart(n);

// ------------------------------------------------------------------- run ----
async function runAutopilot(seed) {
  const page = await newPage(seed);
  const r = await page.evaluate(async (secs) => {
    const g = window.game, FIXED = 1 / 120;
    g.startPlay();
    const steps = Math.round(secs / FIXED);
    const speeds = [], deaths = [], distSeries = [];
    let attachedSteps = 0, stallSteps = 0, floorSteps = 0, releases = 0, wasAttached = false, runs = 1;
    let lastX = g.player.x, stuckSteps = 0, worstStuck = 0, minHushLag = 1e9;
    let noAnchorSteps = 0, freeSteps = 0, driftSteps = 0;
    let totalDist = 0, runStart = g.player.x;
    for (let i = 0; i < steps; i++) {
      g.input.setSynthetic(g.autopilot());
      g.step(FIXED);
      g.input.endFrame();
      const p = g.player;
      if (g.mode === 'dead') {
        deaths.push({ cause: p.deathCause || '?', t: +(i * FIXED).toFixed(2), d: Math.round(p.maxX / 10), v: Math.round(p.speed) });
        totalDist += p.maxX - runStart;
        g.startPlay(); runs++; lastX = g.player.x; runStart = g.player.x; wasAttached = false;
        continue;
      }
      speeds.push(p.speed);
      if (p.attached) attachedSteps++; else {
        freeSteps++;
        if (!g.world.pickAnchor(p.x, p.y, p.vx, p.vy, 620)) noAnchorSteps++;
      }
      if (wasAttached && !p.attached) releases++;
      wasAttached = p.attached;
      if (p.speed < 220) stallSteps++;
      if ((g.world.bandBot(p.x) - p.y) < 240) floorSteps++;
      if ((p.inDraft || 0) > 0.02) driftSteps++;
      if (p.x - lastX < 0.05) { stuckSteps++; if (stuckSteps > worstStuck) worstStuck = stuckSteps; } else stuckSteps = 0;
      lastX = p.x;
      const lag = p.x - g.world.hushX;
      if (lag < minHushLag) minHushLag = lag;
      if (i % 600 === 0) distSeries.push(Math.round(p.maxX / 10));
    }
    totalDist += g.player.maxX - runStart;
    return {
      seed: g.seed, runs, deaths,
      finalDist: Math.round(g.player.maxX / 10),
      totalDist: Math.round(totalDist / 10),
      distSeries, speeds, releases,
      attachFrac: attachedSteps / Math.max(1, speeds.length),
      stallFrac: stallSteps / Math.max(1, speeds.length),
      floorFrac: floorSteps / Math.max(1, speeds.length),
      draftFrac: driftSteps / Math.max(1, speeds.length),
      noAnchorFrac: noAnchorSteps / Math.max(1, freeSteps),
      worstStuck, minHushLag: Math.round(minHushLag),
    };
  }, SECS);
  await page.close();
  return r;
}

// ----------------------------------------------------------------- skill ----
/**
 * Identical pendulum every time; the ONLY variable is the rope angle at which
 * the button comes up. Payoff = ground gained in the 2.5 s of free flight that
 * follows (capped at first wall contact so a bounce cannot flatter a bad
 * release). If payoff is flat across angles, "when do I let go" is not a skill.
 */
async function runSkill(seed) {
  const page = await newPage(seed);
  const r = await page.evaluate(async (fxSrc, rigSrc) => {
    const g = window.game, FIXED = 1 / 120;
    const fx = eval(fxSrc), RIG = eval(rigSrc);
    g.startPlay();
    const w = g.world;
    RIG.clear(w);
    const P = g.player.constructor;

    const probe = (releaseDeg) => {
      const p = g.player;
      p.reset();
      // roomy stretch of trench; anchor sits where a real anchor would
      const x0 = 1400;
      const top = w.bandTop(x0), bot = w.bandBot(x0);
      const ay = top + (bot - top) * 0.20;
      const rope = 430;
      p.x = x0; p.y = ay + rope; p.vx = 700; p.vy = 0;
      const a = { kind: 0, x: x0, y: ay, r: 24, used: 0, alive: true, big: false };
      p.anchor = a; p.rope = rope; p.holdTime = 0; p.sinceRelease = 0;
      const target = releaseDeg * Math.PI / 180;

      let released = false, relSpeed = 0, relX = 0, relY = 0, relT = 0, held = 0;
      let apex = 0, maxV = 0, wallT = -1, dxAtWall = 0;
      const T = 12 * 120;
      for (let i = 0; i < T; i++) {
        let want = true;
        if (!released) {
          const phi = RIG.phi(p, a);
          if (p.holdTime > 0.06 && RIG.rising(p, a) && phi >= target) want = false;
        }
        p.update(FIXED, w, { held: want }, fx, i * FIXED);
        if (!released && !p.attached) {
          released = true; relSpeed = p.speed; relX = p.x; relY = p.y; relT = i * FIXED;
          held = p.holdTime;
        }
        if (p.speed > maxV) maxV = p.speed;
        if (released) {
          apex = Math.min(apex, p.y - relY);
          const nearWall = (p.y >= w.bandBot(p.x) - 16.1) || (p.y <= w.bandTop(p.x) + 16.1);
          if (wallT < 0 && nearWall) { wallT = i * FIXED - relT; dxAtWall = p.x - relX; }
          if ((i * FIXED - relT) > 2.5) break;
        }
        if (!p.alive) break;
      }
      const flight = wallT < 0 ? 2.5 : wallT;
      const dx = wallT < 0 ? p.x - relX : dxAtWall;
      return {
        deg: releaseDeg, fired: released, held: +held.toFixed(2),
        dx: Math.round(dx), relSpeed: Math.round(relSpeed), maxV: Math.round(maxV),
        rise: Math.round(-apex), flight: +flight.toFixed(2),
      };
    };

    const out = [];
    for (let d = -40; d <= 90; d += 5) out.push(probe(d));
    return out;
  }, FX_SRC, RIG_SRC);
  await page.close();
  return r;
}

// ---------------------------------------------------------------- policy ----
/**
 * Four players, same world, no hazards, no Hush. Distance is the only score.
 * A good release policy must beat a sloppy one by a margin a human can feel.
 */
async function runPolicy(seed, secs) {
  const page = await newPage(seed);
  const r = await page.evaluate(async (fxSrc, rigSrc, secs) => {
    const g = window.game, FIXED = 1 / 120;
    const fx = eval(fxSrc), RIG = eval(rigSrc);

    const play = (kind) => {
      g.startPlay();
      const w = g.world;
      RIG.clear(w);
      const p = g.player;
      const reach = 620;
      const speeds = [];
      let holdWhen = 0, releases = 0, stall = 0;
      const steps = Math.round(secs / FIXED);
      for (let i = 0; i < steps; i++) {
        let want;
        if (p.attached) {
          const a = p.anchor;
          const deg = RIG.phi(p, a) * 180 / Math.PI;
          if (kind === 'good') want = !(p.holdTime > 0.18 && RIG.rising(p, a) && deg > 26 && deg < 62);
          else if (kind === 'sloppy') want = p.holdTime < 0.34;
          else if (kind === 'mash') want = p.holdTime < 0.05;
          else if (kind === 'cling') want = p.holdTime < 2.4;
          else want = true;
          if (p.holdTime > 3.0) want = false;   // never hang forever
        } else {
          want = kind === 'nofly' ? false : true;
        }
        const was = p.attached;
        p.update(FIXED, w, { held: want }, fx, i * FIXED);
        w.update(FIXED, i * FIXED, Math.max(p.x, 0));
        if (was && !p.attached) releases++;
        speeds.push(p.speed);
        if (p.speed < 220) stall++;
        if (!p.alive) break;
      }
      return {
        kind, dist: Math.round(p.maxX / 10), releases,
        alive: p.alive, cause: p.deathCause || '-',
        vMean: Math.round(speeds.reduce((s, x) => s + x, 0) / Math.max(1, speeds.length)),
        vP90: Math.round([...speeds].sort((a, b) => a - b)[Math.round(0.9 * (speeds.length - 1))] || 0),
        stallFrac: stall / Math.max(1, speeds.length),
      };
    };
    return ['good', 'sloppy', 'mash', 'cling', 'nofly'].map(play);
  }, FX_SRC, RIG_SRC, secs);
  await page.close();
  return r;
}

// ------------------------------------------------------------------ pump ----
async function runPump(seed) {
  const page = await newPage(seed);
  const r = await page.evaluate(async (fxSrc, rigSrc) => {
    const g = window.game, FIXED = 1 / 120;
    const fx = eval(fxSrc), RIG = eval(rigSrc);
    g.startPlay();
    const w = g.world; RIG.clear(w);
    const p = g.player;
    p.reset();
    const x0 = 1400, top = w.bandTop(x0), bot = w.bandBot(x0);
    const ay = top + (bot - top) * 0.20;
    p.x = x0; p.y = ay + 460; p.vx = 500; p.vy = 0;
    const a = { kind: 0, x: x0, y: ay, r: 24, used: 0, alive: true, big: false };
    p.anchor = a; p.rope = 460; p.holdTime = 0;
    const samples = [];
    for (let i = 0; i < 120 * 7; i++) {
      p.update(FIXED, w, { held: true }, fx, i * FIXED);
      if (i % 30 === 0) samples.push({
        t: +(i * FIXED).toFixed(2), v: Math.round(p.speed), rope: Math.round(p.rope),
        spin: +p.spin.toFixed(2), wind: +(p.windUp === undefined ? -1 : p.windUp).toFixed(2),
      });
      if (!p.alive) break;
    }
    return samples;
  }, FX_SRC, RIG_SRC);
  await page.close();
  return r;
}

// ---------------------------------------------------------------- rescue ----
/** Dropped on the trench floor, dead stop. Does the vent give the game back? */
async function runRescue(seed) {
  const page = await newPage(seed);
  const r = await page.evaluate(async (fxSrc, rigSrc) => {
    const g = window.game, FIXED = 1 / 120;
    const fx = eval(fxSrc), RIG = eval(rigSrc);
    const out = [];
    for (const x0 of [1200, 2600, 4200, 7000]) {
      g.startPlay();
      const w = g.world; RIG.clear(w);
      w.populate(x0 + 4000);
      const p = g.player;
      p.reset();
      p.x = x0; p.y = w.bandBot(x0) - 20; p.vx = 0; p.vy = 0;
      let tReach = -1, tAttach = -1, maxUp = 0;
      const bot = w.bandBot(x0);
      for (let i = 0; i < 120 * 12; i++) {
        // hold the button the whole time: the player is trying to escape
        p.update(FIXED, w, { held: true }, fx, i * FIXED);
        w.update(FIXED, i * FIXED, Math.max(p.x, 0));
        maxUp = Math.max(maxUp, bot - p.y);
        if (tReach < 0 && w.pickAnchor(p.x, p.y, p.vx, p.vy, 620)) tReach = i * FIXED;
        if (tAttach < 0 && p.attached) { tAttach = i * FIXED; break; }
        if (!p.alive) break;
      }
      out.push({
        x0, bandH: Math.round(w.bandBot(x0) - w.bandTop(x0)),
        maxUp: Math.round(maxUp),
        tReach: +tReach.toFixed(2), tAttach: +tAttach.toFixed(2), alive: p.alive,
      });
    }
    return out;
  }, FX_SRC, RIG_SRC);
  await page.close();
  return r;
}

// ------------------------------------------------------------------- main ----
try {
  if (MODE === 'run') {
    console.log(`autopilot  ${SECS}s per seed\n`);
    const rows = [];
    for (const s of SEEDS) rows.push(await runAutopilot(s));
    console.log('seed  dist  tot  runs deaths          v:p10/p50/p90/max      att%  stall% floor% draft% noAnc%  hushMin');
    for (const r of rows) {
      const causes = {};
      for (const d of r.deaths) causes[d.cause] = (causes[d.cause] || 0) + 1;
      const cs = Object.entries(causes).map(([k, v]) => `${k}x${v}`).join(' ') || 'none';
      console.log(
        `${String(r.seed).padEnd(5)}${pad(r.finalDist, 5)}${pad(r.totalDist, 5)} ${pad(r.runs, 4)} ${cs.padEnd(16)}` +
        `${pad(Math.round(pct(r.speeds, 0.10)), 5)}/${pad(Math.round(pct(r.speeds, 0.5)), 4)}/${pad(Math.round(pct(r.speeds, 0.9)), 4)}/${pad(Math.round(Math.max(...r.speeds)), 4)}` +
        `  ${pad(f1(r.attachFrac * 100), 5)}  ${pad(f1(r.stallFrac * 100), 5)}  ${pad(f1(r.floorFrac * 100), 5)}  ${pad(f1(r.draftFrac * 100), 5)}  ${pad(f1(r.noAnchorFrac * 100), 5)}  ${pad(r.minHushLag, 6)}` +
        `${r.worstStuck > 120 ? '  STUCK!' : ''}`
      );
    }
    const all = rows.flatMap(r => r.speeds);
    console.log(`\nall seeds: mean v=${Math.round(mean(all))} p50=${Math.round(pct(all, 0.5))} deaths=${rows.reduce((s, r) => s + r.deaths.length, 0)} releases=${rows.reduce((s, r) => s + r.releases, 0)} totalDist=${rows.reduce((s, r) => s + r.totalDist, 0)}m`);
    console.log(`dist over time (5s bins), seed ${rows[0].seed}: ${rows[0].distSeries.join(' ')}`);
  } else if (MODE === 'skill') {
    for (const s of SEEDS) {
      const rows = await runSkill(s);
      console.log(`\nseed ${s} - release-angle sweep (rope angle from straight-down, + = ahead of anchor)`);
      console.log(' deg  fired  held   dx  relV  maxV  rise  flight  payoff');
      const best = rows.reduce((b, r) => (r.dx > b.dx ? r : b), rows[0]);
      for (const r of rows) {
        const bar = '#'.repeat(Math.max(0, Math.round((r.dx / Math.max(1, best.dx)) * 34)));
        console.log(`${pad(r.deg, 4)} ${pad(r.fired ? 'y' : 'NO', 5)} ${pad(r.held, 5)} ${pad(r.dx, 5)} ${pad(r.relSpeed, 5)} ${pad(r.maxV, 5)} ${pad(r.rise, 5)} ${pad(r.flight, 6)}  ${bar}${r.deg === best.deg ? ' <= best' : ''}`);
      }
      const worst = rows.reduce((b, r) => (r.dx < b.dx ? r : b), rows[0]);
      const within = rows.filter(r => r.dx > best.dx * 0.92).length;
      console.log(`best ${best.deg}deg dx=${best.dx}  worst ${worst.deg}deg dx=${worst.dx}  spread=${f1(best.dx / Math.max(1, worst.dx))}x`);
      console.log(`sweet spot (>=92% of best): ${within} samples = ${within * 5}deg wide`);
    }
  } else if (MODE === 'policy') {
    console.log(`policy comparison, ${SECS}s, no hazards, no Hush\n`);
    for (const s of SEEDS) {
      const rows = await runPolicy(s, SECS);
      console.log(`seed ${s}`);
      console.log('  policy   dist(m)  rel  vMean  vP90  stall%  end');
      const good = rows.find(r => r.kind === 'good');
      for (const r of rows) {
        console.log(`  ${r.kind.padEnd(8)} ${pad(r.dist, 7)} ${pad(r.releases, 4)} ${pad(r.vMean, 6)} ${pad(r.vP90, 5)} ${pad(f1(r.stallFrac * 100), 6)}  ${r.alive ? 'alive' : 'died:' + r.cause}`);
      }
      const sl = rows.find(r => r.kind === 'sloppy');
      console.log(`  good/sloppy = ${f1(good.dist / Math.max(1, sl.dist))}x   good/mash = ${f1(good.dist / Math.max(1, rows.find(r => r.kind === 'mash').dist))}x   good/cling = ${f1(good.dist / Math.max(1, rows.find(r => r.kind === 'cling').dist))}x\n`);
    }
  } else if (MODE === 'pump') {
    const rows = await runPump(SEEDS[0]);
    console.log('sustained hold + reel (does pumping add energy?)');
    console.log('   t    v  rope  spin  wind');
    for (const r of rows) console.log(`${pad(r.t, 5)} ${pad(r.v, 4)} ${pad(r.rope, 5)} ${pad(r.spin, 6)} ${pad(r.wind, 5)}`);
  } else if (MODE === 'rescue') {
    for (const s of SEEDS) {
      const rows = await runRescue(s);
      console.log(`seed ${s} - dropped on the floor at zero speed`);
      console.log('     x  bandH  maxUp  tReach  tAttach  alive');
      for (const r of rows) console.log(`${pad(r.x0, 6)} ${pad(r.bandH, 6)} ${pad(r.maxUp, 6)} ${pad(r.tReach, 7)} ${pad(r.tAttach, 8)}  ${r.alive}`);
      console.log('');
    }
  }
} finally {
  await browser.close();
  server.close();
}

if (problems.length) { console.error('\nPROBLEMS:\n' + problems.map(p => '  - ' + p).join('\n')); process.exit(1); }
