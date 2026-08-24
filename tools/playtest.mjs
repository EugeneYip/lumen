#!/usr/bin/env node
/**
 * End-to-end play test against the REAL game loop.
 *
 *   node tools/playtest.mjs [--seconds 20] [--w 1600] [--h 900]
 *
 * Everything else in this repo drives the simulation directly with
 * `LUMEN.seekTo`, which is what makes captures reproducible but also means the
 * production path is never exercised: no requestAnimationFrame, no real input
 * events, no accumulator under variable frame time, no audio.
 *
 * This loads the page *without* `?headless=1`, so the real rAF loop runs, and
 * plays it with synthesised mouse events. It reports frame pacing, whether the
 * accumulator keeps up, whether input actually reaches the tether, and whether
 * the run progresses. Exits non-zero on a real problem.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const SECONDS = Number(arg('seconds', 20));
const W = Number(arg('w', 1600)), H = Number(arg('h', 900));

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8' };
const server = createServer(async (q, r) => {
  try {
    let p = decodeURIComponent(new URL(q.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if ((await stat(f)).isDirectory()) throw 0;
    const b = await readFile(f);
    r.writeHead(200, { 'Content-Type': MIME[extname(f).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store' });
    r.end(b);
  } catch { r.writeHead(404).end('404'); }
});
await new Promise((r) => server.listen(0, r));
const PORT = server.address().port;

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--hide-scrollbars', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });

const problems = [];
const IGNORE = /favicon|Failed to load resource/i;
page.on('console', (m) => { if (m.type() === 'error' && !IGNORE.test(m.text())) problems.push('console: ' + m.text()); });
page.on('pageerror', (e) => problems.push('pageerror: ' + (e?.message || e)));

// No ?headless=1 - this is the production boot path.
await page.goto(`http://127.0.0.1:${PORT}/?seed=7`, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForFunction('window.LUMEN && window.LUMEN.ready === true', { timeout: 45000, polling: 50 });

// Instrument the real loop from the outside.
await page.evaluate(() => {
  window.__pt = { dts: [], steps: [], maxAcc: 0 };
  const g = window.game;
  const frame = g.frame.bind(g);
  let last = null;
  g.frame = function (now) {
    if (last != null) window.__pt.dts.push(now - last);
    last = now;
    const before = g.t;
    frame(now);
    window.__pt.steps.push(Math.round((g.t - before) * 120));
    window.__pt.maxAcc = Math.max(window.__pt.maxAcc, g.acc);
  };
});

// Play it: hold and release on a rhythm that a person could produce.
const canvas = { x: W / 2, y: H / 2 };
await page.mouse.move(canvas.x, canvas.y);
const t0 = Date.now();
let presses = 0;
while (Date.now() - t0 < SECONDS * 1000) {
  await page.mouse.down();
  await new Promise((r) => setTimeout(r, 260 + Math.round(Math.sin(presses) * 90)));
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 190));
  presses++;
}

const out = await page.evaluate(() => {
  const g = window.game;
  const pt = window.__pt;
  const dts = pt.dts.slice().sort((a, b) => a - b);
  const q = (p) => dts[Math.min(dts.length - 1, Math.floor(p * dts.length))];
  const stepped = pt.steps.reduce((a, b) => a + b, 0);
  return {
    mode: g.mode,
    depth: Math.round(g.player.maxX / 10),
    best: Math.round(g.best),
    frames: dts.length,
    medianMs: +q(0.5).toFixed(2), p95Ms: +q(0.95).toFixed(2), worstMs: +q(1).toFixed(2),
    fps: Math.round(1000 / q(0.5)),
    // A vsync'd loop lands on multiples of the refresh interval, so count
    // buckets rather than a single "slow" threshold: 33.3ms is a dropped frame,
    // not a stall, and lumping the two together hides which is happening.
    at60: dts.filter((d) => d < 22).length,
    at30: dts.filter((d) => d >= 22 && d < 40).length,
    stalls: dts.filter((d) => d >= 40).length,
    maxStepsInAFrame: Math.max(...pt.steps),
    // Warm-up always hitches (shader compile, first upload), so judge
    // saturation on the steady state only.
    saturatedAfterWarmup: pt.steps.slice(30).filter((n) => n >= 8).length,
    framesAfterWarmup: Math.max(1, pt.steps.length - 30),
    stepsTotal: stepped,
    maxAccumulator: +pt.maxAcc.toFixed(5),
    audioReady: g.audio.ready, audioSilent: g.audio.silent,
    everTethered: g.player.everTethered === undefined ? null : g.player.everTethered,
    renderer: g.caps.renderer,
  };
});

await browser.close();
server.close();

console.log(`\nreal-loop play test  ${SECONDS}s, ${W}x${H}, ${presses} press/release cycles`);
console.log(`  renderer     ${out.renderer}`);
console.log(`  frames       ${out.frames}  median ${out.medianMs}ms (${out.fps} fps)  p95 ${out.p95Ms}ms  worst ${out.worstMs}ms`);
console.log(`  pacing       ${out.at60} at ~60fps, ${out.at30} dropped to ~30fps, ${out.stalls} stalls over 40ms`);
console.log(`               (headless has no real display, so a 60/30 split here is usually a`);
console.log(`                compositor artefact -- trust the CPU and GPU budgets in check.mjs,`);
console.log(`                and judge real pacing on a machine with a screen)`);
const satPct = (out.saturatedAfterWarmup / out.framesAfterWarmup * 100).toFixed(1);
console.log(`  sim          ${out.stepsTotal} steps, peak accumulator ${out.maxAccumulator}s, saturated ${out.saturatedAfterWarmup}/${out.framesAfterWarmup} frames after warm-up (${satPct}%)`);
console.log(`  run          mode=${out.mode}  reached ${out.depth}m  best ${out.best}m`);
console.log(`  audio        ready=${out.audioReady} silent=${out.audioSilent}`);

// The accumulator clamps at MAX_STEPS (8); sitting there means the sim cannot
// keep up with wall time and the game is running slow motion.
// One saturated frame is a hitch; many means the sim genuinely cannot keep up
// with wall time and the game is silently running in slow motion.
const satFrac = out.saturatedAfterWarmup / out.framesAfterWarmup;
if (satFrac > 0.02) problems.push(`sim saturated on ${(satFrac * 100).toFixed(1)}% of frames after warm-up - the fixed-step loop cannot keep up and the game is running slow`);
if (out.stalls > out.frames * 0.05) problems.push(`${out.stalls} frames over 40ms (${(out.stalls / out.frames * 100).toFixed(1)}%) - visible hitching`);
if (out.depth < 20) problems.push(`the run went nowhere (${out.depth}m) - real mouse input may not be reaching the tether`);
if (out.medianMs > 20) problems.push(`median frame ${out.medianMs}ms is below 50fps`);
if (out.audioReady !== true) problems.push('audio never initialised from a real gesture (autoplay path broken?)');

if (problems.length) {
  console.error('\nFAILED\n' + problems.map((p) => '  - ' + p).join('\n'));
  process.exit(1);
}
console.log('\nOK  the production loop, input path and audio all work.\n');
