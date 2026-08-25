#!/usr/bin/env node
/**
 * TEMPORARY feel-measurement harness (physics agent scratch; delete when done).
 *
 *   node tools/_feel.mjs --mode run    --seeds 3,7,11,19 --secs 60
 *   node tools/_feel.mjs --mode skill  --seeds 7
 *   node tools/_feel.mjs --mode policy --seeds 7,3 [--live]
 *   node tools/_feel.mjs --mode pump
 *   node tools/_feel.mjs --mode rescue
 *
 * run    : deterministic autopilot; distance/speed/attach/deaths/stalls.
 * skill  : release-angle sweep -> does release TIMING pay off, and how much?
 * policy : good vs sloppy vs mashing vs clinging over a long run.
 *          --live keeps hazards, plankton and the Hush. WITHOUT it the world is
 *          sterile and the numbers answer a different question - see the note
 *          at the policy reporting block before quoting any of them.
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
const LIVE = argv.includes('--live');   // policy mode: run the real world, not the sterile rig

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
  // ...and the opposite: the world as the game actually presents it. The Hush
  // advance lives in main.js's step, which this harness deliberately does not
  // run, so a policy loop that only calls player.update and world.update gets a
  // Hush frozen wherever it started even if nothing clears it. Replicated here
  // from main.js: speed lerp(196,470,difficulty), and the rubber band that stops
  // it falling more than lerp(2900,1750) behind, which is what stops distance
  // banking into permanent safety.
  live: (w, p, dt, grace) => {
    if (grace > 0) return;
    const d = w.difficultyAt(p.x);
    w.hushX += (196 + (470 - 196) * d) * dt;
    const maxLag = 2900 + (1750 - 2900) * d;
    if (p.x - w.hushX > maxLag) w.hushX = p.x - maxLag;
  },
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
    g.input.setSynthetic(false); g.input.endFrame();   // newRun does not clear it
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
  const r = await page.evaluate(async (fxSrc, rigSrc, secs, LIVE) => {
    const g = window.game, FIXED = 1 / 120;
    const fx = eval(fxSrc), RIG = eval(rigSrc);

    const play = (kind) => {
      g.startPlay();
      const w = g.world;
      if (!LIVE) RIG.clear(w);
      const p = g.player;
      const reach = 620;
      const speeds = [];
      let holdWhen = 0, releases = 0, stall = 0, grace = 1.4;
      const i0 = { n: 0 };
      const steps = Math.round(secs / FIXED);
      for (let i = 0; i < steps; i++) {
        let want;
        if (p.attached) {
          const a = p.anchor;
          const deg = RIG.phi(p, a) * 180 / Math.PI;
          if (kind === 'good') want = !(p.holdTime > 0.18 && RIG.rising(p, a) && deg > 8 && deg < 30);
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
        if (LIVE) { RIG.live(w, p, FIXED, grace); grace = Math.max(0, grace - FIXED); }
        w.update(FIXED, i * FIXED, Math.max(p.x, LIVE ? w.hushX : 0));
        if (was && !p.attached) releases++;
        speeds.push(p.speed);
        if (p.speed < 220) stall++;
        i0.n = i + 1;
        if (!p.alive) break;
      }
      return {
        kind, dist: Math.round(p.maxX / 10), releases,
        alive: p.alive, cause: p.deathCause || '-',
        // The chain multiplier is half the real score and the sterile lab
        // cannot see it at all, because RIG.clear() deletes every plankton.
        mult: +(p.mult || 1).toFixed(1), chain: Math.round(p.chain || 0),
        secs: +((i0.n) / 120).toFixed(1),
        vMean: Math.round(speeds.reduce((s, x) => s + x, 0) / Math.max(1, speeds.length)),
        vP90: Math.round([...speeds].sort((a, b) => a - b)[Math.round(0.9 * (speeds.length - 1))] || 0),
        stallFrac: stall / Math.max(1, speeds.length),
      };
    };
    return ['good', 'sloppy', 'mash', 'cling', 'nofly'].map(play);
  }, FX_SRC, RIG_SRC, secs, LIVE);
  await page.close();
  return r;
}

// ------------------------------------------------------------------ hold ----
/**
 * The decision, measured. Same world, same start; the only variable is how long
 * the button is held before it comes up. If distance is monotonic in hold time
 * then holding is always right and there is no decision to make. We want an
 * interior maximum with a visible penalty on both sides of it.
 */
async function runHold(seed, secs) {
  const page = await newPage(seed);
  const r = await page.evaluate(async (fxSrc, rigSrc, secs) => {
    const g = window.game, FIXED = 1 / 120;
    const fx = eval(fxSrc), RIG = eval(rigSrc);
    const out = [];
    for (let h = 0.1; h <= 2.81; h += 0.1) {
      g.startPlay();
      const w = g.world; RIG.clear(w);
      const p = g.player;
      const speeds = [];
      let releases = 0, qSum = 0;
      const steps = Math.round(secs / FIXED);
      for (let i = 0; i < steps; i++) {
        const was = p.attached;
        const want = p.attached ? p.holdTime < h : true;
        p.update(FIXED, w, { held: want }, fx, i * FIXED);
        w.update(FIXED, i * FIXED, Math.max(p.x, 0));
        if (was && !p.attached) { releases++; qSum += p.releaseQ || 0; }
        speeds.push(p.speed);
        if (!p.alive) break;
      }
      out.push({
        hold: +h.toFixed(1), dist: Math.round(p.maxX / 10), releases,
        vMean: Math.round(speeds.reduce((s, x) => s + x, 0) / Math.max(1, speeds.length)),
        q: +(qSum / Math.max(1, releases)).toFixed(2),
        alive: p.alive, cause: p.deathCause || '-',
      });
    }
    return out;
  }, FX_SRC, RIG_SRC, secs);
  await page.close();
  return r;
}

// ------------------------------------------------------------------- cam ----
/** Log camera state across a launch: does it anticipate, punch, and settle? */
async function runCam(seed, secs) {
  const page = await newPage(seed);
  const r = await page.evaluate(async (secs) => {
    const g = window.game, FIXED = 1 / 120;
    g.startPlay();
    g.input.setSynthetic(false); g.input.endFrame();
    const out = [];
    let lastSeq = g.player.launchSeq, capture = -1;
    let maxRot = 0, maxShake = 0, maxPunch = 0, zMin = 9, zMax = 0;
    const steps = Math.round(secs / FIXED);
    for (let i = 0; i < steps; i++) {
      g.input.setSynthetic(g.autopilot());
      g.step(FIXED);
      g.input.endFrame();
      const p = g.player, c = g.cam;
      maxRot = Math.max(maxRot, Math.abs(c.rot));
      maxShake = Math.max(maxShake, Math.hypot(c.shakeX, c.shakeY));
      maxPunch = Math.max(maxPunch, Math.hypot(c.punchX, c.punchY));
      zMin = Math.min(zMin, c.zoom); zMax = Math.max(zMax, c.zoom);
      // grab the window around the first well-timed launch after 3s
      if (capture < 0 && p.launchSeq !== lastSeq && i * FIXED > 3 && (p.releaseQ || 0) > 0.5) capture = i;
      lastSeq = p.launchSeq;
      if (capture >= 0 && i >= capture - 42 && i <= capture + 108 && (i - capture) % 6 === 0) {
        out.push({
          d: i - capture, wind: +(p.windUp || 0).toFixed(2), antic: +c.antic.toFixed(2),
          lag: Math.round(c.baseX - p.x), punch: Math.round(c.punchX),
          zoom: +c.zoom.toFixed(3), rot: +(c.rot * 57.3).toFixed(2),
          shake: Math.round(Math.hypot(c.shakeX, c.shakeY)), v: Math.round(p.speed),
          rw: +(p.releaseWindow || 0).toFixed(2), q: +(p.releaseQ || 0).toFixed(2),
        });
      }
    }
    return { out, maxRot: +(maxRot * 57.3).toFixed(2), maxShake: Math.round(maxShake), maxPunch: Math.round(maxPunch), zMin: +zMin.toFixed(3), zMax: +zMax.toFixed(3) };
  }, secs);
  await page.close();
  return r;
}

// ----------------------------------------------------------------- stuck ----
/** Run the autopilot, catch the worst no-progress window, dump what happened. */
async function runStuck(seed, secs) {
  const page = await newPage(seed);
  const r = await page.evaluate(async (secs) => {
    const g = window.game, FIXED = 1 / 120;
    g.startPlay();
    g.input.setSynthetic(false); g.input.endFrame();
    const steps = Math.round(secs / FIXED);
    let run = 0, best = null, lastX = g.player.x;
    const ring = [];
    for (let i = 0; i < steps; i++) {
      g.input.setSynthetic(g.autopilot());
      g.step(FIXED);
      g.input.endFrame();
      const p = g.player, w = g.world;
      if (g.mode === 'dead') { g.startPlay(); run = 0; lastX = g.player.x; ring.length = 0; continue; }
      if (p.x - lastX < 0.05) run++; else run = 0;
      lastX = p.x;
      if (i % 12 === 0) {
        ring.push({
          t: +(i * FIXED).toFixed(2), x: Math.round(p.x), y: Math.round(p.y),
          top: Math.round(w.bandTop(p.x)), bot: Math.round(w.bandBot(p.x)),
          v: Math.round(p.speed), vx: Math.round(p.vx), vy: Math.round(p.vy),
          att: p.attached ? 1 : 0, hold: +p.holdTime.toFixed(2),
          rope: Math.round(p.rope), ax: p.anchor ? Math.round(p.anchor.x) : 0,
          ay: p.anchor ? Math.round(p.anchor.y) : 0,
          draft: +(p.inDraft || 0).toFixed(2), rw: +(p.releaseWindow || 0).toFixed(2),
          anc: g.world.pickAnchor(p.x, p.y, p.vx, p.vy, 620) ? 1 : 0,
          dgr: g._pathDanger(p, 0.42) ? 1 : 0,
        });
        if (ring.length > 90) ring.shift();
      }
      if (run > 140 && (!best || run > best.run)) best = { run, at: i * FIXED, trace: [...ring] };
    }
    return best;
  }, secs);
  await page.close();
  return r;
}

// ------------------------------------------------------------------ tune ----
/**
 * Sweep P overrides against the autopilot without editing the file. ES modules
 * are cached, so importing player.js from the page hands back the same object
 * main.js is using and mutating P takes effect live.
 *
 *   --mode tune --vals "gravity=1560;gravity=1700;gravity=2050" --seeds 3,7,11
 */
async function runTune(seed, variants, secs) {
  const page = await newPage(seed);
  const r = await page.evaluate(async (variants, secs) => {
    const g = window.game, FIXED = 1 / 120;
    const mod = await import('/src/game/player.js');
    const base = { ...mod.P };
    const out = [];
    for (const v of variants) {
      Object.assign(mod.P, base);
      for (const [k, val] of Object.entries(v.set)) mod.P[k] = val;
      g.startPlay();
      g.input.setSynthetic(false); g.input.endFrame();   // newRun does not clear it
      const speeds = [];
      let att = 0, draft = 0, floor = 0, stall = 0, noAnc = 0, free = 0;
      let deaths = 0, totalDist = 0, runStart = g.player.x, releases = 0, wasAtt = false;
      const steps = Math.round(secs / FIXED);
      for (let i = 0; i < steps; i++) {
        g.input.setSynthetic(g.autopilot());
        g.step(FIXED);
        g.input.endFrame();
        const p = g.player;
        if (g.mode === 'dead') {
          deaths++; totalDist += p.maxX - runStart;
          g.startPlay(); runStart = g.player.x; wasAtt = false;
          continue;
        }
        speeds.push(p.speed);
        if (p.attached) att++; else {
          free++;
          if (!g.world.pickAnchor(p.x, p.y, p.vx, p.vy, mod.P.reach)) noAnc++;
        }
        if (wasAtt && !p.attached) releases++;
        wasAtt = p.attached;
        if ((p.inDraft || 0) > 0.02) draft++;
        if ((g.world.bandBot(p.x) - p.y) < 200) floor++;
        if (p.speed < 220) stall++;
      }
      totalDist += g.player.maxX - runStart;
      const n = Math.max(1, speeds.length);
      out.push({
        label: v.label, dist: Math.round(totalDist / 10), deaths, releases,
        v: Math.round(speeds.reduce((s, x) => s + x, 0) / n),
        att: att / n, draft: draft / n, floor: floor / n, stall: stall / n,
        noAnc: noAnc / Math.max(1, free),
      });
    }
    Object.assign(mod.P, base);
    return out;
  }, variants, secs);
  await page.close();
  return r;
}

// ----------------------------------------------------------------- phase ----
/**
 * The real decision variable. A closed loop that grabs whatever is in reach and
 * lets go the moment the rope passes `deg` ahead of the anchor while swinging
 * forward. Sweeping `deg` sweeps "when do I let go" directly, with the pendulum
 * period taken out of the picture. This curve is the game.
 */
async function runPhase(seed, secs) {
  const page = await newPage(seed);
  const r = await page.evaluate(async (fxSrc, rigSrc, secs) => {
    const g = window.game, FIXED = 1 / 120;
    const fx = eval(fxSrc), RIG = eval(rigSrc);
    const out = [];
    for (let deg = -30; deg <= 90.1; deg += 5) {
      g.startPlay();
      const w = g.world; RIG.clear(w);
      const p = g.player;
      const target = deg * Math.PI / 180;
      const speeds = [];
      let releases = 0, qSum = 0, stall = 0;
      const steps = Math.round(secs / FIXED);
      for (let i = 0; i < steps; i++) {
        let want = true;
        if (p.attached) {
          const phi = RIG.phi(p, p.anchor);
          if (p.holdTime > 0.06 && RIG.rising(p, p.anchor) && phi >= target) want = false;
          if (p.holdTime > 3.2) want = false;          // never hang forever
        }
        const was = p.attached;
        p.update(FIXED, w, { held: want }, fx, i * FIXED);
        w.update(FIXED, i * FIXED, Math.max(p.x, 0));
        if (was && !p.attached) { releases++; qSum += p.releaseQ || 0; }
        speeds.push(p.speed);
        if (p.speed < 220) stall++;
        if (!p.alive) break;
      }
      out.push({
        deg, dist: Math.round(p.maxX / 10), releases,
        vMean: Math.round(speeds.reduce((s, x) => s + x, 0) / Math.max(1, speeds.length)),
        q: +(qSum / Math.max(1, releases)).toFixed(2),
        stallFrac: stall / Math.max(1, speeds.length),
        alive: p.alive, cause: p.deathCause || '-',
      });
    }
    return out;
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
        `${r.worstStuck > 120 ? '  STUCK ' + f1(r.worstStuck / 120) + 's' : ''}`
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
    // READ THIS BEFORE BELIEVING A POLICY NUMBER. Without --live the world is
    // sterile: RIG.clear() deletes every plankton and hazard and pushes the Hush
    // out of the universe. That is the right lab for asking whether the PENDULUM
    // rewards timing, and the wrong one for asking whether the GAME does, because
    // it removes both the punishment for being slow and the reward for routing.
    // It produced a genuinely alarming and completely false headline: `nofly` --
    // a policy that never presses the button at all, and reports 0 releases
    // because it never even attaches -- matched a good player over 60s on one
    // seed and beat it by 31% on another. In the real game the Hush advances at
    // lerp(196,470,difficulty) and nofly's mean speed is 266-310, so it is
    // outrun by the front as soon as difficulty passes about 0.27. The lab had
    // deleted the one system whose entire job is to punish drifting.
    console.log(`policy comparison, ${SECS}s, ${LIVE ? 'LIVE world - hazards, plankton and the Hush all on' : 'no hazards, no Hush (pendulum only - see the note in the source)'}\n`);
    for (const s of SEEDS) {
      const rows = await runPolicy(s, SECS);
      console.log(`seed ${s}`);
      console.log(`  policy   dist(m)  rel  vMean  vP90  stall%${LIVE ? '  mult  lived' : ''}  end`);
      const good = rows.find(r => r.kind === 'good');
      for (const r of rows) {
        console.log(`  ${r.kind.padEnd(8)} ${pad(r.dist, 7)} ${pad(r.releases, 4)} ${pad(r.vMean, 6)} ${pad(r.vP90, 5)} ${pad(f1(r.stallFrac * 100), 6)}` +
          (LIVE ? ` ${pad('x' + r.mult, 5)} ${pad(r.secs + 's', 6)}` : '') +
          `  ${r.alive ? 'alive' : 'died:' + r.cause}`);
      }
      const sl = rows.find(r => r.kind === 'sloppy');
      console.log(`  good/sloppy = ${f1(good.dist / Math.max(1, sl.dist))}x   good/mash = ${f1(good.dist / Math.max(1, rows.find(r => r.kind === 'mash').dist))}x   good/cling = ${f1(good.dist / Math.max(1, rows.find(r => r.kind === 'cling').dist))}x\n`);
    }
  } else if (MODE === 'hold') {
    for (const s of SEEDS) {
      const rows = await runHold(s, SECS);
      const best = rows.reduce((b, r) => (r.dist > b.dist ? r : b), rows[0]);
      console.log(`\nseed ${s} - distance vs hold time over ${SECS}s (no hazards, no Hush)`);
      console.log(' hold  dist(m)  rel  vMean    q  payoff');
      for (const r of rows) {
        const bar = '#'.repeat(Math.max(0, Math.round((r.dist / Math.max(1, best.dist)) * 34)));
        console.log(`${pad(r.hold, 5)} ${pad(r.dist, 8)} ${pad(r.releases, 4)} ${pad(r.vMean, 6)} ${pad(r.q, 4)}  ${bar}${r.hold === best.hold ? ' <= best' : ''}${r.alive ? '' : ' died:' + r.cause}`);
      }
      const first = rows[0], last = rows[rows.length - 1];
      console.log(`best hold=${best.hold}s dist=${best.dist}m   short(0.1s)=${first.dist}m (${f1(first.dist / best.dist * 100)}%)   long(${last.hold}s)=${last.dist}m (${f1(last.dist / best.dist * 100)}%)`);
      console.log(best.hold > first.hold && best.hold < last.hold ? 'INTERIOR OPTIMUM: holding has a cost as well as a benefit.' : 'MONOTONIC: no decision to make.');
    }
  } else if (MODE === 'cam') {
    for (const s of SEEDS) {
      const r = await runCam(s, SECS);
      console.log(`\nseed ${s}: camera across one good launch (d = steps from release)`);
      console.log(`  extremes over ${SECS}s: |rot| max ${r.maxRot}deg  shake max ${r.maxShake}u  punch max ${r.maxPunch}u  zoom ${r.zMin}..${r.zMax}`);
      console.log('    d  wind antic   lag punch   zoom    rot shake    v   rw    q');
      for (const q of r.out) {
        console.log(`${pad(q.d, 5)} ${pad(q.wind, 5)} ${pad(q.antic, 5)} ${pad(q.lag, 5)} ${pad(q.punch, 5)} ${pad(q.zoom, 6)} ${pad(q.rot, 6)} ${pad(q.shake, 5)} ${pad(q.v, 4)} ${pad(q.rw, 4)} ${pad(q.q, 4)}`);
      }
    }
  } else if (MODE === 'stuck') {
    for (const s of SEEDS) {
      const r = await runStuck(s, SECS);
      if (!r) { console.log(`seed ${s}: no stall over ${SECS}s`); continue; }
      console.log(`\nseed ${s}: worst stall ${f1(r.run / 120)}s ending at t=${f1(r.at)}s`);
      console.log('    t      x      y    top    bot    v     vx    vy att hold rope     ax     ay draft   rw anc dgr');
      for (const q of r.trace) {
        console.log(`${pad(q.t, 5)} ${pad(q.x, 6)} ${pad(q.y, 6)} ${pad(q.top, 6)} ${pad(q.bot, 6)} ${pad(q.v, 4)} ${pad(q.vx, 6)} ${pad(q.vy, 6)} ${pad(q.att, 3)} ${pad(q.hold, 4)} ${pad(q.rope, 4)} ${pad(q.ax, 6)} ${pad(q.ay, 6)} ${pad(q.draft, 5)} ${pad(q.rw, 4)} ${pad(q.anc, 3)} ${pad(q.dgr, 3)}`);
      }
    }
  } else if (MODE === 'tune') {
    const variants = String(arg('vals', 'gravity=2050')).split(';').map(spec => ({
      label: spec.trim(),
      set: Object.fromEntries(spec.split(',').map(kv => {
        const [k, v] = kv.split('=');
        return [k.trim(), Number(v)];
      })),
    }));
    const agg = new Map();
    for (const s of SEEDS) {
      const rows = await runTune(s, variants, SECS);
      console.log(`\nseed ${s} (${SECS}s each)`);
      console.log('  variant                   dist(m) deaths  rel  vMean   att%  draft% floor% stall% noAnc%');
      for (const r of rows) {
        console.log(`  ${r.label.padEnd(24)} ${pad(r.dist, 7)} ${pad(r.deaths, 6)} ${pad(r.releases, 4)} ${pad(r.v, 6)} ${pad(f1(r.att * 100), 6)} ${pad(f1(r.draft * 100), 6)} ${pad(f1(r.floor * 100), 6)} ${pad(f1(r.stall * 100), 6)} ${pad(f1(r.noAnc * 100), 6)}`);
        const a = agg.get(r.label) || { dist: 0, deaths: 0, v: 0, att: 0, draft: 0, noAnc: 0, n: 0 };
        a.dist += r.dist; a.deaths += r.deaths; a.v += r.v; a.att += r.att; a.draft += r.draft; a.noAnc += r.noAnc; a.n++;
        agg.set(r.label, a);
      }
    }
    console.log('\nACROSS ALL SEEDS');
    console.log('  variant                   dist(m) deaths  vMean   att%  draft% noAnc%');
    const sorted = [...agg.entries()].sort((a, b) => b[1].dist - a[1].dist);
    for (const [label, a] of sorted) {
      console.log(`  ${label.padEnd(24)} ${pad(a.dist, 7)} ${pad(a.deaths, 6)} ${pad(Math.round(a.v / a.n), 6)} ${pad(f1(a.att / a.n * 100), 6)} ${pad(f1(a.draft / a.n * 100), 6)} ${pad(f1(a.noAnc / a.n * 100), 6)}`);
    }
  } else if (MODE === 'phase') {
    for (const s of SEEDS) {
      const rows = await runPhase(s, SECS);
      const best = rows.reduce((b, r) => (r.dist > b.dist ? r : b), rows[0]);
      const worst = rows.reduce((b, r) => (r.dist < b.dist ? r : b), rows[0]);
      console.log(`\nseed ${s} - distance vs RELEASE PHASE over ${SECS}s (no hazards, no Hush)`);
      console.log('  deg  dist(m)  rel  vMean    q  stall%  payoff');
      for (const r of rows) {
        const bar = '#'.repeat(Math.max(0, Math.round((r.dist / Math.max(1, best.dist)) * 34)));
        console.log(`${pad(r.deg, 5)} ${pad(r.dist, 8)} ${pad(r.releases, 4)} ${pad(r.vMean, 6)} ${pad(r.q, 4)} ${pad(f1(r.stallFrac * 100), 6)}  ${bar}${r.deg === best.deg ? ' <= best' : ''}`);
      }
      const inner = best.deg > rows[0].deg && best.deg < rows[rows.length - 1].deg;
      console.log(`best ${best.deg}deg=${best.dist}m  worst ${worst.deg}deg=${worst.dist}m  spread=${f1(best.dist / Math.max(1, worst.dist))}x  ${inner ? 'INTERIOR OPTIMUM' : 'EDGE OPTIMUM'}`);
      const wide = rows.filter(r => r.dist > best.dist * 0.88).length;
      console.log(`sweet spot (>=88% of best): ${wide} samples = ${wide * 5}deg wide`);
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
