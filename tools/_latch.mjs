#!/usr/bin/env node
/**
 * _latch.mjs -- which frame does a scene predicate actually resolve at, and how
 * much does that depend on the number in it?
 *
 *   node tools/_latch.mjs 7,3
 *   node tools/_latch.mjs 2,3,4,5,6,7,8,9,10,11,42 0.003,0.0006,0.0002,0.0001
 *
 * Replays the gate's own opening exactly -- seekTo(0.001), then the seekUntil
 * loop step for step -- but instead of breaking on the predicate it records
 * every step. From ONE boot per seed it then answers, for any list of candidate
 * flash thresholds, which step `tethered` first fires on. Candidates that pick
 * the same step are the same frame, so a whole band can be ruled equivalent
 * without a render run each (a `_floor` pass over the gate's frames is ~8min;
 * this is seconds, and it renders nothing).
 *
 * WHY IT EXISTS. `tethered`'s flash gate was set by eye twice -- 0.01, then
 * 0.0006 -- and both times the next agent had no way to see whether the number
 * was load-bearing or arbitrary. It prints the answer directly, as the list of
 * frames satisfying the NON-flash half of the predicate: the flash gate can only
 * ever select one of those, so the GAPS between them are plateaus.
 *
 * WHAT IT FOUND (2026-08). `attached && holdTime > 0.25` is true in only two
 * windows in the first 1.6s: t~0.26-0.55, while the opening flash decays 3.2e-2
 * to about 3.1e-3; then the mote is airborne; then t~0.88-0.98 onward, entered
 * at 1.4e-4 to 3.1e-4 depending on seed. The threshold is therefore NOT a dial.
 * It is a binary selector between two attach windows, and on all 11 seeds every
 * value in (3.11e-4, 3.14e-3] picks the byte-identical frame -- a 10x band, with
 * 0.0006 sitting 1.9x above its floor and 5.2x below its ceiling. 0.01 landed in
 * window ONE, at flash 9.7e-3, which is the entire defect.
 *
 * So do not re-tune this number expecting a small move. Below 3.1e-4 you get a
 * different `tethered` frame and BYTE-IDENTICAL `launch` and `fast`: seeking
 * observes the sim without perturbing it, so a downstream scene resolves at the
 * same absolute sim time no matter where the previous seek stopped, as long as
 * it stopped first. Measured 0.0001 against 0.0006 -- `fast` is identical to the
 * pixel on both gate seeds. Nothing downstream can be tuned from here.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const SEEDS = String(process.argv[2] || '7,3').split(',').map(Number);
const CANDS = String(process.argv[3] || '0.01,0.005,0.003,0.002,0.001,0.0007,0.0006,0.0005,0.0004,0.0003,0.0002,0.0001,0.00005,0')
  .split(',').map(Number);
const HORIZON = Number(process.argv[4] || 4.0);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.png': 'image/png', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if ((await stat(f)).isDirectory()) throw 0;
    const b = await readFile(f);
    res.writeHead(200, { 'Content-Type': MIME[extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': b.length });
    res.end(b);
  } catch { res.writeHead(404).end('404'); }
});
await new Promise(r => server.listen(0, r));
const PORT = server.address().port;
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--hide-scrollbars', '--mute-audio', '--font-render-hinting=none'] });

for (const seed of SEEDS) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${PORT}/?headless=1&seed=${seed}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction('window.LUMEN && window.LUMEN.ready === true', { timeout: 180000, polling: 50 });

  await page.evaluate(() => window.LUMEN.seekTo(0.001));       // exactly what the gate does for `title`
  const trace = await page.evaluate((horizon) => {
    const FIXED = 1 / 120;
    const g = window.game;
    if (g.mode === 'title') g.startPlay();                     // seekUntil's first act
    g._seekEntryDepth = g.player.maxX * 20;
    const t0 = g.t, out = [];
    let guard = 0;
    while (g.t < t0 + horizon && guard++ < 400000) {
      if (g.mode === 'dead' && g.deadT > 1.2) g.startPlay();
      g.input.setSynthetic(g.autopilot());
      g.step(FIXED);
      g.input.endFrame();
      out.push({ t: +(g.t - t0).toFixed(5), flash: g.flash,
                 att: !!g.player.attached, hold: g.player.holdTime,
                 x: Math.round(g.player.x) });
    }
    return out;
  }, HORIZON);

  console.log(`\n=== seed ${seed} === (${trace.length} steps traced)`);
  const ok = trace.filter(s => s.att && s.hold > 0.25);
  console.log(`first frame with attached && holdTime>0.25 : t=${ok[0]?.t}s flash=${ok[0]?.flash.toExponential(3)}`);
  // Every frame that satisfies the NON-flash half of the predicate, in order.
  // The flash gate can only ever select one of these, so the gaps between them
  // ARE the plateaus: any threshold landing inside a gap picks the same frame.
  console.log('  qualifying frames (att && hold>0.25), first 1.6s:');
  let run = null;
  for (const s of trace) {
    if (s.t > 1.6) break;
    if (!(s.att && s.hold > 0.25)) { if (run) { console.log(`    t ${run.a.toFixed(4)}..${run.b.toFixed(4)}  flash ${run.fa.toExponential(3)}..${run.fb.toExponential(3)}`); run = null; } continue; }
    if (!run) run = { a: s.t, b: s.t, fa: s.flash, fb: s.flash };
    else { run.b = s.t; run.fb = s.flash; }
  }
  if (run) console.log(`    t ${run.a.toFixed(4)}..${run.b.toFixed(4)}  flash ${run.fa.toExponential(3)}..${run.fb.toExponential(3)}`);
  console.log('thresh      step   t(s)     flash        x     | frames with att&&hold in [prev,this)');
  let prevIdx = null;
  for (const c of CANDS) {
    const i = trace.findIndex(s => s.att && s.hold > 0.25 && s.flash < c);
    if (i < 0) { console.log(`${String(c).padEnd(10)}  (never within horizon)`); continue; }
    const s = trace[i];
    const same = i === prevIdx ? '  <-- SAME FRAME as previous threshold' : '';
    console.log(`${String(c).padEnd(10)} ${String(i).padStart(5)} ${s.t.toFixed(4).padStart(7)} ${s.flash.toExponential(3).padStart(11)} ${String(s.x).padStart(6)}${same}`);
    prevIdx = i;
  }
  await page.close();
}
await browser.close(); server.close();
