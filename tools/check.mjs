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
  // An art-direction review measured 84% of one frame inside a 32-code-value
  // band, with 0.3% of pixels below L8: murk and bloom with no midtone, and an
  // abyss that never reaches black. These two are reported as warnings because
  // they are composition targets rather than defects, but they are the numbers
  // that axis is judged on.
  shadowFracMin: 0.08,   // fraction below L8; a real abyss wants 0.15-0.25
  // ...and a ceiling, because a one-sided target gets optimised past the point
  // of value. Chasing the floor drove the environment to 38-54% below L8, and a
  // blind reviewer then preferred the OLDER build on all four pairs, describing
  // the newer one as crushing "an entire wall plane and stalactite field to
  // flat black" -- geometry the level artist had built and the tone curve was
  // deleting. Blacks are a floor to reach, not a quantity to maximise.
  shadowFracMax: 0.36,
  moteContrastMin: 4.0,  // focal core vs its local surround, at any speed
  // Focal contrast is local: it only asks whether the mote beats its own
  // immediate surround. An art director measured the mote as the 10th and then
  // the 43rd most salient bright cluster in its own frame -- locally fine,
  // globally lost. This ranks the hero against every other HIGHLIGHT in the
  // frame, which is the question a player scanning a still actually asks. Read
  // the note at the measurement site before touching either number: the rank is
  // now over distinct highlight peaks (16-79 per frame), not over 336 fixed
  // cells, so `3` is a different and much stricter demand than it used to be.
  moteRankMax: 3,
  // What counts as a highlight, in display luminance. Measured across all ten
  // gate frames the 99.9th percentile lands at 0.597-0.749, so this is "the
  // brightest tenth of a percent of the image" in every scene, and it sits
  // clear above the brightest flat background in any of them (peak 0.44).
  highlightLum: 0.60,
  // NOTE: there is deliberately no detail threshold. See the `detail` column,
  // which is reported as a trend line only -- and read the note in AI_HANDOFF
  // section 8 about why a frame-wide statistic cannot gate craft.
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
        const lum = await page.evaluate((HL) => {
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
          const vals2 = new Float32Array(n);   // unsorted, for spatial sampling
          for (let i = 0, j = 0; i < d.length; i += 4, j++) {
            const l = (d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722) / 255;
            vals[j] = l; vals2[j] = l; sum += l;
            if (l >= 0.99) clipped++;
            if (l < 0.008) black++;
            if (l > max) max = l;
          }
          // Focal clarity: the player's core against its own surround. If the
          // bloom, the streak and the particle field all pile into one value
          // band, the eye loses the protagonist exactly when it needs it.
          let contrast = null;
          try {
            const g = window.game;
            const uv = g.cam.worldToUv(g.player.x, g.player.y);
            // worldToUv returns GL convention (v measured from the bottom);
            // a 2D canvas indexes from the top. Without the flip this sampled
            // the mote's vertical mirror image, which is why frames with the
            // mote near mid-screen scored plausibly and frames with it high or
            // low scored 1:1.
            const cx = uv[0] * t.width, cy = (1 - uv[1]) * t.height;
            if (cx > 6 && cy > 6 && cx < t.width - 6 && cy < t.height - 6) {
              let core = 0, ring = 0, ringN = 0;
              for (let y = -7; y <= 7; y++) for (let x = -7; x <= 7; x++) {
                const px = Math.round(cx + x), py = Math.round(cy + y);
                if (px < 0 || py < 0 || px >= t.width || py >= t.height) continue;
                const l = vals2[py * t.width + px];
                const r = Math.hypot(x, y);
                if (r <= 2) core = Math.max(core, l);
                else if (r >= 5) { ring += l; ringN++; }
              }
              if (ringN) contrast = core / Math.max(ring / ringN, 1e-3);
            }
          } catch { /* mote off-screen */ }

          // NATIVE-resolution luminance. Two measurements below need it and the
          // 192x108 sample above is wrong for both: see each for why.
          const f = document.createElement('canvas');
          f.width = src.width; f.height = src.height;
          const fx = f.getContext('2d', { willReadFrequently: true });
          fx.drawImage(src, 0, 0);
          const fd = fx.getImageData(0, 0, f.width, f.height).data;
          const W2 = f.width, H2 = f.height;
          const lum = new Float32Array(W2 * H2);
          for (let i = 0, j = 0; i < fd.length; i += 4, j++) {
            lum[j] = (fd[i] * 0.2126 + fd[i + 1] * 0.7152 + fd[i + 2] * 0.0722) / 255;
          }

          // Global salience: where does the hero sit among the frame's
          // HIGHLIGHTS? A hero-sized window centred on the mote, scored by the
          // energy it carries above `highlightLum`, ranked against windows of
          // the same size taken at every offset across the frame, with
          // overlapping windows collapsed so one bright object counts once.
          //
          // This replaces a fixed 24x14 grid of blocks ranked by sum(L^2), and
          // it is the fifth measurement on this project to have been wrong in a
          // way that cost art rounds. Two independent defects, both measured on
          // the ten gate frames:
          //
          // GRID PHASE. The mote is small and hot and its glow spills across
          // cell boundaries, so which cell it lands in decided the answer.
          // Re-measuring the SAME IMAGE with the grid origin shifted by a
          // fraction of a cell moved seed 7 / title from rank 1 to rank 29, and
          // seed 3 / title from 6 to 40. Across all ten frames the phase swing
          // was 2x to 6x. The published ranks (2 to 13 for a hero that looks
          // much the same frame to frame) were mostly reporting where the mote
          // happened to land relative to an arbitrary lattice. A dense stride is
          // the fix and it is free: the answer is identical at stride 4, 8, 16
          // and 24, because collapsing overlaps removes the offset entirely.
          //
          // "HIGHLIGHT ENERGY" WAS NOT MEASURING HIGHLIGHTS. sum(L^2) over a
          // fixed area is an area integral, and squaring does not rescue it. On
          // seed 7 / title the lit rock wall at (169,232) -- peak 0.43, p90
          // 0.40, flat enough to have no highlight anywhere in it -- outscored
          // the mote's block, whose peak is 0.96. Same on seed 3 / title, and
          // the Hush wall did it twice on seed 7 / hushNear. A patch that is
          // uniformly half-lit cannot be a highlight rival to a white-hot core,
          // and a metric named for highlight energy must not say it is.
          // Thresholding at `highlightLum` removes that population by
          // construction and leaves the real rivals -- the anchor bulbs and the
          // seabed colonies -- exactly where they were.
          //
          // Also: the mote is the single brightest PIXEL in the frame in all ten
          // gate frames. A metric that then places it 13th needed explaining,
          // and the explanation was not the art.
          //
          // Teeth, because the risk with any replacement is that it passes
          // trivially. Re-scoring the hero's own window with its pixels scaled
          // down (i.e. simulating a dimmer mote) moves it from rank 1-2 to rank
          // 2-10 at 0.85x, 8-30 at 0.70x, and below every peak in frame at
          // 0.55x. Arbitrary non-hero windows rank at or near last. It is a
          // steeper response than the grid version had.
          //
          // `peaks` is reported alongside the rank on purpose. A build that wins
          // this by deleting rivals rather than by leading the eye shows up as
          // the peak count collapsing, in the same column.
          let moteRank = null, motePeaks = 0;
          try {
            const g = window.game;
            const winW = Math.round(W2 / 24), winH = Math.round(H2 / 14);
            const ii = new Float64Array((W2 + 1) * (H2 + 1));
            for (let yy = 0; yy < H2; yy++) {
              let rs = 0;
              for (let xx = 0; xx < W2; xx++) {
                const d = lum[yy * W2 + xx] - HL;
                if (d > 0) rs += d * d;
                ii[(yy + 1) * (W2 + 1) + xx + 1] = ii[yy * (W2 + 1) + xx + 1] + rs;
              }
            }
            const score = (x0, y0) => ii[(y0 + winH) * (W2 + 1) + x0 + winW]
              - ii[y0 * (W2 + 1) + x0 + winW] - ii[(y0 + winH) * (W2 + 1) + x0]
              + ii[y0 * (W2 + 1) + x0];

            const cands = [];
            for (let y0 = 0; y0 + winH <= H2; y0 += 8)
              for (let x0 = 0; x0 + winW <= W2; x0 += 8) {
                const s = score(x0, y0);
                if (s > 0) cands.push({ x0, y0, s });
              }
            cands.sort((a, b) => b.s - a.s);
            // Non-maximum suppression: two peaks must be at least one hero-width
            // apart to count as two things. Without this the "rank" counts
            // window offsets rather than objects.
            const peaks = [];
            for (const c of cands) {
              if (peaks.some(k => Math.abs(k.x0 - c.x0) < winW && Math.abs(k.y0 - c.y0) < winH)) continue;
              peaks.push(c);
            }

            const uv = g.cam.worldToUv(g.player.x, g.player.y);
            // worldToUv is GL convention (v from the bottom); see the flip note
            // on the focal measurement above.
            const mx = uv[0] * W2, my = (1 - uv[1]) * H2;
            if (mx >= 0 && my >= 0 && mx < W2 && my < H2) {
              const hx = Math.max(0, Math.min(W2 - winW, Math.round(mx - winW / 2)));
              const hy = Math.max(0, Math.min(H2 - winH, Math.round(my - winH / 2)));
              const mine = score(hx, hy);
              let better = 0;
              for (const k of peaks) {
                if (Math.abs(k.x0 - hx) < winW && Math.abs(k.y0 - hy) < winH) continue;
                if (k.s > mine) better++;
              }
              moteRank = better + 1;
              motePeaks = peaks.length;
            }
          } catch { /* mote off-screen */ }

          // Local structure. The 192x108 sample is useless here: at a 6.7x
          // downsample a prop's beaded filaments are sub-pixel, and a frame-wide
          // mean over that sample was measured to be identical across a build
          // where a reviewer could plainly see one prop go from filaments to
          // airbrush.
          //
          // It reports the 90th percentile rather than the mean, because the
          // defect is localised — a handful of props smoothed out barely moves
          // an average dominated by grain and rock, but it does move the top of
          // the distribution, which is where crisp structure lives.
          let detail = 0;
          {
            const laps = [];
            for (let yy = 1; yy < H2 - 1; yy += 2) {
              for (let xx = 1; xx < W2 - 1; xx += 2) {
                const i = yy * W2 + xx;
                laps.push(Math.abs(4 * lum[i] - lum[i - 1] - lum[i + 1] - lum[i - W2] - lum[i + W2]));
              }
            }
            laps.sort();
            detail = laps.length ? laps[Math.floor(laps.length * 0.90)] : 0;
          }

          let shadow = 0;
          for (let i = 0; i < n; i++) if (vals[i] < 8 / 255) shadow++;
          const shadowFrac = shadow / n;

          vals.sort();
          const q = (p) => vals[Math.min(n - 1, Math.floor(p * n))];
          return { mean: sum / n, max, clipped: clipped / n, black: black / n,
            shadowFrac, contrast, moteRank, motePeaks, detail,
            p20: q(0.2), p50: q(0.5), p90: q(0.9), p95: q(0.95), p99: q(0.99) };
        }, BUDGET.highlightLum);

        S.scenes[sc] = { ...lum, depth: info?.depth, speed: info?.speed, mode: info?.mode };

        const tag = `seed ${seed} / ${sc}`;
        if (lum.mean < BUDGET.meanLumMin) fails.push(`${tag}: too dark — mean luminance ${lum.mean.toFixed(4)} < ${BUDGET.meanLumMin}`);
        else if (lum.mean > BUDGET.meanLumMax) fails.push(`${tag}: too bright — mean luminance ${lum.mean.toFixed(3)} > ${BUDGET.meanLumMax}`);
        if (lum.clipped > BUDGET.clippedMax) fails.push(`${tag}: ${(lum.clipped * 100).toFixed(1)}% of pixels clipped to white (max ${(BUDGET.clippedMax * 100)}%)`);
        if (lum.black > BUDGET.blackMax) warns.push(`${tag}: ${(lum.black * 100).toFixed(1)}% of pixels are near-black`);
        if (lum.shadowFrac < BUDGET.shadowFracMin) warns.push(`${tag}: no real blacks — only ${(lum.shadowFrac * 100).toFixed(1)}% of pixels below L8 (want > ${BUDGET.shadowFracMin * 100}%); the abyss never reaches black`);
        else if (lum.shadowFrac > BUDGET.shadowFracMax) warns.push(`${tag}: crushed — ${(lum.shadowFrac * 100).toFixed(1)}% of pixels below L8 (want < ${BUDGET.shadowFracMax * 100}%); geometry is being deleted rather than darkened`);
        if (lum.moteRank != null && lum.moteRank > BUDGET.moteRankMax) warns.push(`${tag}: hero is not salient — the mote is the ${lum.moteRank}th of ${lum.motePeaks} highlight peaks in the frame (want top ${BUDGET.moteRankMax}); a player scanning the still cannot find their character`);
        if (lum.contrast != null && lum.contrast < BUDGET.moteContrastMin) warns.push(`${tag}: weak focal point — mote core only ${lum.contrast.toFixed(1)}:1 over its surround (want > ${BUDGET.moteContrastMin}:1)`);
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
        // Take the BEST of several batches, not one sample. Contention can only
        // make a render slower, never faster, so the minimum is the honest
        // estimate of what the frame costs -- and a single sample has produced
        // false failures three times on this project, spanning 7.9ms to 22.8ms
        // for the same build depending on what else was running.
        let renderMs = Infinity;
        for (let rep = 0; rep < 5; rep++) {
          const t0 = performance.now();
          for (let i = 0; i < 10; i++) g.render(1 / 120);
          gl.finish();
          renderMs = Math.min(renderMs, (performance.now() - t0) / 10);
        }
        let stepUs = Infinity;
        for (let rep = 0; rep < 3; rep++) {
          const t1 = performance.now();
          for (let i = 0; i < 400; i++) { g.step(1 / 120); g.input.endFrame(); }
          stepUs = Math.min(stepUs, ((performance.now() - t1) / 400) * 1000);
        }
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
      // Stronger: re-render a FROZEN state several times. Run-to-run comparison
      // misses a renderer that varies per draw call, which is how an unverified
      // shader with a per-draw GL hazard reached the tree unnoticed.
      const frozen = await page.evaluate(() => {
        const g = window.game;
        const h = () => {
          g.render(1 / 120);
          const t = document.createElement('canvas');
          t.width = 160; t.height = 90;
          const x = t.getContext('2d', { willReadFrequently: true });
          x.drawImage(document.getElementById('gl'), 0, 0, t.width, t.height);
          const d = x.getImageData(0, 0, t.width, t.height).data;
          let v = 2166136261;
          for (let i = 0; i < d.length; i++) { v ^= d[i]; v = Math.imul(v, 16777619); }
          return (v >>> 0).toString(16);
        };
        return [h(), h(), h(), h(), h()];
      });
      const distinct = new Set(frozen).size;
      S.frozenRender = distinct;
      if (distinct > 1) {
        fails.push(`seed ${seed}: RENDER varies per draw call — 5 renders of one frozen state gave ${distinct} distinct images (${frozen.join(' ')}). Frames cannot be compared between builds.`);
      }

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
      console.log(`  ${sc.padEnd(11)} mean ${v.mean.toFixed(4)}  p50 ${v.p50.toFixed(3)}  spread ${(v.p95 - v.p20).toFixed(3)}` +
        `  shadow ${((v.shadowFrac || 0) * 100).toFixed(1)}%  focal ${v.contrast ? v.contrast.toFixed(1) + ':1' : '--'}` +
        `  rank ${v.moteRank != null ? v.moteRank + '/' + v.motePeaks : '--'}  detail ${(v.detail || 0).toFixed(4)}` +
        `  clipped ${(v.clipped * 100).toFixed(2)}%  black ${(v.black * 100).toFixed(1)}%  (${v.depth}m)`);
    }
  }
  if (warns.length) console.log('\nWARN\n' + warns.map(w => '  - ' + w).join('\n'));
  if (fails.length) console.log('\nFAIL\n' + fails.map(f => '  - ' + f).join('\n'));
  console.log(fails.length ? `\n${fails.length} failure(s)` : '\nAll checks passed.');
}
process.exit(fails.length ? 1 : 0);
