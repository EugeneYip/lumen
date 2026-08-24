#!/usr/bin/env node
/**
 * Build health guard. Run this after any change; it catches the regressions
 * that are easy to ship and hard to notice.
 *
 *   node tools/check.mjs [--seeds 7,3] [--w 1600] [--h 900] [--json]
 *
 * Checks
 *   boot        page reaches LUMEN.ready quickly
 *   errors      zero console errors / page errors / failed requests
 *   exposure    per-scene luminance histogram is in a sane band
 *               (this is what catches "the whole frame went black")
 *   clipping    not blowing out to white mush
 *   perf        render submit + GPU completion inside budget
 *   sim         fixed-step cost inside budget, and the autopilot still plays
 *   determinism the same seed produces the same state twice
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const SEEDS = String(arg('seeds', '7,3')).split(',').map(Number);
const W = Number(arg('w', 1600)), H = Number(arg('h', 900));
const JSON_OUT = argv.includes('--json');

const SCENES = ['title', 'tethered', 'launch', 'fast', 'hushNear'];

const BUDGET = {
  bootMs: 5000,
  renderMs: 12,          // submit + gl.finish at W x H
  stepUs: 120,           // one 1/120s sim step
  meanLumMin: 0.045,     // darker than this and the frame is effectively black
  meanLumMax: 0.240,     // this is an abyss; brighter than this and it is a milky mess
  clippedMax: 0.060,     // fraction of pixels at >=0.99 luminance
  blackMax: 0.900,       // fraction of pixels at <0.008 luminance
  minDepth: 40,          // autopilot must get somewhere
  minSpread: 0.14,       // p95-p20 luminance: below this the frame is flat mush
};

/**
 * Targets for the HDR scene *before* tonemapping, linear. This is the contract
 * between the environment (which authors the dark bulk) and the grade (which
 * authors the response). Without it the two run away from each other: the first
 * time we measured, the water bulk sat at linear 0.13 and nothing in the frame
 * exceeded 1.0, so there were no shadows, no highlights, and no shoulder to
 * tonemap - a milky mid-grey wall.
 */
const HDR = {
  p50Max: 0.030,   // the bulk of an abyss is deep shadow
  p90Max: 0.150,
  p99Min: 0.250,   // there must be real highlights
  maxMin: 6.0,     // emitter cores must be genuinely hot, or bloom has nothing
};

/**
 * Per-scene allowances. The Hush is a deliberate full-frame violet event -- it
 * is *supposed* to flood the frame, so holding it to the deep-shadow bulk of
 * ordinary play would be enforcing the wrong thing. The allowance is set just
 * above the measured value rather than switched off, so the exception cannot
 * quietly become a licence to keep brightening.
 */
const HDR_SCENE = {
  hushNear: { p50Max: 0.055, p90Max: 0.200 },
};

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.png': 'image/png', '.json': 'application/json' };
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

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--hide-scrollbars', '--mute-audio', '--font-render-hinting=none'],
});

const fails = [], warns = [], report = { seeds: {} };

for (const seed of SEEDS) {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  const IGNORE = /favicon|Failed to load resource/i;
  const errs = [];
  page.on('console', m => { if (m.type() === 'error' && !IGNORE.test(m.text())) errs.push('console: ' + m.text()); });
  page.on('pageerror', e => errs.push('pageerror: ' + (e?.message || e)));
  page.on('requestfailed', r => { if (!IGNORE.test(r.url())) errs.push('requestfailed: ' + r.url()); });

  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${PORT}/?headless=1&seed=${seed}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  let booted = true;
  try {
    await page.waitForFunction('window.LUMEN && window.LUMEN.ready === true', { timeout: 45000, polling: 50 });
  } catch {
    booted = false;
    const be = await page.evaluate(() => window.__LUMEN_BOOT_ERROR__ || '(no boot error recorded)');
    fails.push(`seed ${seed}: never became ready — ${String(be).slice(0, 400)}`);
  }
  const bootMs = Date.now() - t0;
  const S = { bootMs, scenes: {}, errors: [] };
  report.seeds[seed] = S;

  if (booted) {
    if (bootMs > BUDGET.bootMs) warns.push(`seed ${seed}: boot ${bootMs}ms > ${BUDGET.bootMs}ms`);

    for (const sc of SCENES) {
      try {
        const info = sc === 'title'
          ? await page.evaluate(() => window.LUMEN.seekTo(0.001))
          : await page.evaluate((c) => window.LUMEN.seekUntil(c, 60), sc);

        // Sample the GL canvas in the same task as a fresh render: the context
        // has preserveDrawingBuffer:false, so the pixels are only readable
        // before the frame is presented.
        const lum = await page.evaluate(() => {
          window.game.render(1 / 120);
          const src = document.getElementById('gl');
          const t = document.createElement('canvas');
          t.width = 192; t.height = 108;
          const x = t.getContext('2d', { willReadFrequently: true });
          x.drawImage(src, 0, 0, t.width, t.height);
          const d = x.getImageData(0, 0, t.width, t.height).data;
          const n = t.width * t.height;
          let sum = 0, clipped = 0, black = 0, max = 0;
          const vals = new Float32Array(n);
          for (let i = 0, j = 0; i < d.length; i += 4, j++) {
            const l = (d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722) / 255;
            vals[j] = l; sum += l;
            if (l >= 0.99) clipped++;
            if (l < 0.008) black++;
            if (l > max) max = l;
          }
          vals.sort();
          const q = (p) => vals[Math.min(n - 1, Math.floor(p * n))];
          return { mean: sum / n, max, clipped: clipped / n, black: black / n,
            p20: q(0.2), p50: q(0.5), p90: q(0.9), p95: q(0.95), p99: q(0.99) };
        });

        S.scenes[sc] = { ...lum, depth: info?.depth, speed: info?.speed, mode: info?.mode };

        const tag = `seed ${seed} / ${sc}`;
        if (lum.mean < BUDGET.meanLumMin) fails.push(`${tag}: too dark — mean luminance ${lum.mean.toFixed(4)} < ${BUDGET.meanLumMin}`);
        else if (lum.mean > BUDGET.meanLumMax) fails.push(`${tag}: too bright — mean luminance ${lum.mean.toFixed(3)} > ${BUDGET.meanLumMax}`);
        if (lum.clipped > BUDGET.clippedMax) fails.push(`${tag}: ${(lum.clipped * 100).toFixed(1)}% of pixels clipped to white (max ${(BUDGET.clippedMax * 100)}%)`);
        if (lum.black > BUDGET.blackMax) warns.push(`${tag}: ${(lum.black * 100).toFixed(1)}% of pixels are near-black`);
        const spread = lum.p95 - lum.p20;
        if (spread < BUDGET.minSpread) fails.push(`${tag}: flat image — p95-p20 luminance spread only ${spread.toFixed(3)} (want > ${BUDGET.minSpread})`);
      } catch (e) {
        fails.push(`seed ${seed} / ${sc}: ${e.message}`);
      }
    }

    // ---- HDR scene structure ----
    try {
      for (const sc of ['tethered', 'fast', 'launch', 'hushNear']) {
        // Restart before each measurement. Without this the probe runs on from
        // wherever the previous scene loop left the world, so it reports a
        // different position than the tonemapped checks above and the two sets
        // of numbers cannot be compared.
        await page.evaluate((c) => {
          const g = window.game;
          g.input.setSynthetic(false); g.input.endFrame();
          g.startPlay();
          return window.LUMEN.seekUntil(c, 60);
        }, sc);
        const h = await page.evaluate(() => window.LUMEN.hdrStats());
        S.scenes[sc] = { ...(S.scenes[sc] || {}), hdr: h };
        const tag = `seed ${seed} / ${sc} HDR`;
        const lim = { ...HDR, ...(HDR_SCENE[sc] || {}) };
        if (h.p50 > lim.p50Max) fails.push(`${tag}: scene bulk too bright — p50 ${h.p50} > ${lim.p50Max} linear (the abyss should be deep shadow)`);
        if (h.p90 > lim.p90Max) warns.push(`${tag}: p90 ${h.p90} > ${lim.p90Max} linear`);
        if (h.p99 < HDR.p99Min) fails.push(`${tag}: no real highlights — p99 only ${h.p99} (want > ${HDR.p99Min})`);
        if (h.max < lim.maxMin) fails.push(`${tag}: nothing is hot — max ${h.max} < ${lim.maxMin} linear, so bloom and the tonemap shoulder have nothing to work with`);
      }
    } catch (e) { warns.push(`seed ${seed}: hdrStats failed — ${e.message}`); }

    // ---- perf ----
    try {
      const perf = await page.evaluate(() => {
        const g = window.game;
        const gl = g.gl;
        g.render(1 / 120); gl.finish();                       // warm
        const t0 = performance.now();
        for (let i = 0; i < 20; i++) g.render(1 / 120);
        gl.finish();
        const renderMs = (performance.now() - t0) / 20;
        const t1 = performance.now();
        for (let i = 0; i < 600; i++) { g.step(1 / 120); g.input.endFrame(); }
        const stepUs = ((performance.now() - t1) / 600) * 1000;
        return { renderMs, stepUs, renderer: g.caps.renderer };
      });
      S.perf = perf;
      if (perf.renderMs > BUDGET.renderMs) fails.push(`seed ${seed}: render ${perf.renderMs.toFixed(2)}ms > ${BUDGET.renderMs}ms budget at ${W}x${H}`);
      if (perf.stepUs > BUDGET.stepUs) fails.push(`seed ${seed}: sim step ${perf.stepUs.toFixed(1)}us > ${BUDGET.stepUs}us budget`);
    } catch (e) { fails.push(`seed ${seed}: perf probe failed — ${e.message}`); }

    // ---- the autopilot must actually play ----
    try {
      const run = await page.evaluate(async () => {
        const g = window.game;
        g.startPlay();
        let deaths = 0, best = 0;
        for (let i = 0; i < 120 * 45; i++) {
          g.input.setSynthetic(g.autopilot());
          g.step(1 / 120);
          g.input.endFrame();
          best = Math.max(best, g.player.maxX / 10);
          if (g.mode === 'dead') { deaths++; g.startPlay(); }
        }
        return { deaths, best: Math.round(best) };
      });
      S.run = run;
      if (run.best < BUDGET.minDepth) fails.push(`seed ${seed}: autopilot only reached ${run.best}m in 45s — movement is broken or the level is impassable`);
    } catch (e) { fails.push(`seed ${seed}: autopilot probe failed — ${e.message}`); }

    // ---- world list ordering ----
    // Hot loops in player.js and render.js break on ascending x, so one
    // inversion silently makes later objects unreachable AND invisible. This
    // shipped once: 18 plankton were uncollectable on seed 7.
    try {
      const inv = await page.evaluate(() => {
        const w = window.game.world;
        w.populate(40000);
        const out = {};
        for (const k of ['anchors', 'hazards', 'plankton', 'decor']) {
          const a = w[k]; let n = 0, worst = 0;
          for (let i = 1; i < a.length; i++) {
            if (a[i].x < a[i - 1].x) { n++; worst = Math.max(worst, a[i - 1].x - a[i].x); }
          }
          if (n) out[k] = { n, worst: Math.round(worst) };
        }
        return out;
      });
      S.ordering = inv;
      for (const [k, v] of Object.entries(inv)) {
        fails.push(`seed ${seed}: world.${k} is not sorted by x — ${v.n} inversion(s), worst ${v.worst} units back. Hot loops break on x and will silently skip objects.`);
      }
    } catch (e) { warns.push(`seed ${seed}: ordering probe failed — ${e.message}`); }

    // ---- determinism: state AND pixels ----
    try {
      const det = await page.evaluate(async () => {
        const run = () => {
          const g = window.game;
          // Input is not part of newRun(), so a probe that ran before this one
          // can leave the synthetic button held and desync step 1.
          g.input.setSynthetic(false); g.input.endFrame();
          g.startPlay();
          for (let i = 0; i < 1200; i++) { g.input.setSynthetic(g.autopilot()); g.step(1 / 120); g.input.endFrame(); }
          const p = g.player;
          const state = [p.x, p.y, p.vx, p.vy, g.world.anchors.length, g.particles.n]
            .map(v => Math.round(v * 1000) / 1000).join('|');
          // Also hash the rendered pixels. State equality does not prove the
          // image is reproducible, and the image is what gets compared between
          // builds, so it is the thing that actually has to be deterministic.
          g.render(1 / 120);
          const t = document.createElement('canvas');
          t.width = 160; t.height = 90;
          const x = t.getContext('2d', { willReadFrequently: true });
          x.drawImage(document.getElementById('gl'), 0, 0, t.width, t.height);
          const d = x.getImageData(0, 0, t.width, t.height).data;
          let h = 2166136261;
          for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 16777619); }
          return { state, pixels: (h >>> 0).toString(16) };
        };
        return { a: run(), b: run() };
      });
      S.determinism = det.a.state === det.b.state && det.a.pixels === det.b.pixels;
      if (det.a.state !== det.b.state) fails.push(`seed ${seed}: simulation NOT deterministic — replay diverged (${det.a.state} vs ${det.b.state})`);
      else if (det.a.pixels !== det.b.pixels) fails.push(`seed ${seed}: RENDER not deterministic — identical state produced different pixels (${det.a.pixels} vs ${det.b.pixels}); frames cannot be compared between builds`);
    } catch (e) { warns.push(`seed ${seed}: determinism probe failed — ${e.message}`); }
  }

  S.errors = errs;
  for (const e of errs) fails.push(`seed ${seed}: ${e}`);
  await page.close();
}

await browser.close();
server.close();

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: fails.length === 0, fails, warns, report }, null, 2));
} else {
  for (const s of SEEDS) {
    const S = report.seeds[s];
    if (!S) continue;
    console.log(`\nseed ${s}  boot ${S.bootMs}ms` +
      (S.perf ? `  render ${S.perf.renderMs.toFixed(2)}ms  step ${S.perf.stepUs.toFixed(0)}us` : '') +
      (S.run ? `  autopilot ${S.run.best}m / ${S.run.deaths} deaths in 45s` : '') +
      (S.determinism === false ? '  NON-DETERMINISTIC' : ''));
    for (const [sc, v] of Object.entries(S.scenes)) {
      if (v.hdr) console.log(`  ${(sc + ' hdr').padEnd(11)} p50 ${v.hdr.p50}  p90 ${v.hdr.p90}  p99 ${v.hdr.p99}  max ${v.hdr.max}   (linear, pre-tonemap)`);
      console.log(`  ${sc.padEnd(11)} mean ${v.mean.toFixed(4)}  p50 ${v.p50.toFixed(3)}  spread ${(v.p95 - v.p20).toFixed(3)}  p99 ${v.p99.toFixed(3)}` +
        `  clipped ${(v.clipped * 100).toFixed(2)}%  black ${(v.black * 100).toFixed(1)}%  (${v.depth}m)`);
    }
  }
  if (warns.length) console.log('\nWARN\n' + warns.map(w => '  - ' + w).join('\n'));
  if (fails.length) console.log('\nFAIL\n' + fails.map(f => '  - ' + f).join('\n'));
  console.log(fails.length ? `\n${fails.length} failure(s)` : '\nAll checks passed.');
}
process.exit(fails.length ? 1 : 0);
