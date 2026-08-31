#!/usr/bin/env node
/**
 * Ruled-line detector. Answers one question: is there a straight, coherent
 * line in this frame, how strong is it against the frame's own level, and what
 * draws it.
 *
 *   node tools/_line.mjs [--seed 7] [--depth 450] [--w 1600] [--h 900]
 *                        [--win 2,130,140,340] [--tiles 1] [--gap 5]
 *                        [--url noSprites=1] [--minus noSprites=1] [--json]
 *
 * WHY IT IS BUILT THIS WAY. The obvious instrument - a high percentile of a
 * high-pass - cannot see a 2px line. It returns whichever of line and grain is
 * larger, and in this scene that is always the grain, which is how one artefact
 * stayed misattributed for four review rounds (see the ablation record above
 * ORIENT_FS in src/engine/postfx.js). A statistic whose 0x and 4x ablations
 * report the SAME value is saturated by something else and means nothing.
 *
 * So: shear-average ALONG a candidate slope first. Over N columns that
 * suppresses per-pixel grain by sqrt(N) while a coherent line keeps its full
 * amplitude - a 128-wide window buys 11x. Then high-pass ACROSS the sheared
 * average, and take the best response over slopes. Everything is reported
 * against the frame's OWN mean level in the same window, so dimming the frame
 * cannot flatter the score: that is the loophole two "fixes" went through, both
 * caught by the reviewer.
 *
 * Reads the linear HDR scene (pre-postfx) and the final 8-bit frame, so the
 * grade's contribution is a subtraction rather than an argument.
 *
 * --minus makes it an ISOLATOR rather than a comparator. It captures twice and
 * detects on the DIFFERENCE, so `--minus noSprites=1` measures what the sprite
 * pass alone draws, with the entire background and ribbon field subtracted
 * away. Levels still come from the full frame, so `rel` stays comparable.
 * Combine with ?onlyLayer=N to isolate a single atlas layer.
 *
 * --tiles splits the window into overlapping columns and reports the best line
 * in each. A line that spans a quarter of the frame is diluted by a shear
 * average taken over the whole width, so a single wide window can hide one.
 *
 * TWO SPECIFICITY TERMS, because "brightest response" is not "line". A shear
 * high-pass fires on any compact bright thing, and the brightest compact thing
 * in this game is the hero - the first version of this tool duly reported the
 * mote at rel 19 and called it a line. The tells that separate them:
 *
 *   aniso     response at the best slope over the MEDIAN response across all
 *             slopes in the same row. A ruled line only survives the shear at
 *             its own slope, so aniso is large. A round core survives every
 *             slope equally, so aniso is about 1 - and it announces itself by
 *             reporting near-identical excursions at wildly different slopes.
 *   coverage  fraction of columns along the candidate whose own cross high-pass
 *             clears half the mean. A stretched quad's medial axis is a segment
 *             of constant brightness, so coverage approaches 1 and cv is small;
 *             a blob crossed by the shear path covers a few columns of many.
 *
 * Candidates are reported twice: the strongest response of any shape, and the
 * strongest that passes both gates (--minAniso, --minCov). The second is the
 * one that answers "is there a ruled line".
 *
 * CALIBRATION, so the gates are not guesses. Measured by reconstructing the
 * artefact this tool was built for - the water striation as ONE quad stretched
 * to aspect 13.5 on S.SHARD, which is what particles.js drew before the
 * three-bead train - and running the tool against the same build with the train
 * restored:
 *
 *   the stretched sliver, isolated   aniso   87   cov 1.00   cv 0.11
 *   the mote's core, same frame      aniso 1377   cov 0.15   cv 3.87
 *   stock scene, best non-line       aniso   38   cov 0.56   cv 0.90
 *
 * So aniso ALONE does not separate them - a bright core scores higher on it
 * than the line does, because a compact feature survives every slope and the
 * median it is divided by is tiny either way. Coverage is what separates them,
 * and cv is the confirmation: a stretched quad's medial axis is a segment of
 * near-constant brightness, so cv collapses toward zero, while anything
 * compact or clumpy sits above 1. Default gates sit between the two
 * populations; for a verdict rather than a survey use --minCov 0.85.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const SEED = Number(arg('seed', 7));
const DEPTH = Number(arg('depth', 450));
const W = Number(arg('w', 1600)), H = Number(arg('h', 900));
const EXTRA = arg('url', '');
const MINUS = arg('minus', null);
const JSON_OUT = argv.includes('--json');
const [X0, X1, Y0, Y1] = String(arg('win', '2,130,140,340')).split(',').map(Number);
const GAP = Number(arg('gap', 5));
const [MLO, MHI, MST] = String(arg('slopes', '-1.2,1.2,0.005')).split(',').map(Number);
const TOPK = Number(arg('top', 3));
const TILES = Number(arg('tiles', 1));
const MIN_ANISO = Number(arg('minAniso', 1.6));
const MIN_COV = Number(arg('minCov', 0.60));

const MAXM = Math.max(Math.abs(MLO), Math.abs(MHI));
const TILEW = Math.floor((X1 - X0 + 1) / TILES);
const PAD = Math.ceil(MAXM * (TILES > 1 ? TILEW : X1 - X0) / 2) + GAP + 2;
const RX0 = Math.max(0, X0 - 1), RX1 = Math.min(W - 1, X1 + 1);
const RY0 = Math.max(0, Y0 - PAD), RY1 = Math.min(H - 1, Y1 + PAD);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' };
const server = createServer(async (q, r) => {
  try {
    let p = decodeURIComponent(new URL(q.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if ((await stat(f)).isDirectory()) throw 0;
    const b = await readFile(f);
    r.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    r.end(b);
  } catch { r.writeHead(404).end('404'); }
});
await new Promise((r) => server.listen(0, r));
const PORT = server.address().port;

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--mute-audio', '--hide-scrollbars'] });
const errs = [];

async function capture(extra) {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => errs.push(String(e && e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon/i.test(m.text())) errs.push(m.text()); });
  await page.goto(`http://127.0.0.1:${PORT}/?headless=1&seed=${SEED}${extra ? '&' + extra : ''}`,
    { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction('window.LUMEN && window.LUMEN.ready === true', { timeout: 45000, polling: 50 });
  const got = await page.evaluate(async (d, rect) => {
    const { rx0, rx1, ry0, ry1 } = rect;
    const g = window.game || window.LUMEN.game;
    const info = await window.LUMEN.seekToDepth(d, 240);
    const rw = rx1 - rx0 + 1, rh = ry1 - ry0 + 1;
    const gl = g.gl, rt = g.post.scene;
    const b64 = (f32) => {
      const u8 = new Uint8Array(f32.buffer);
      let s = ''; const C = 0x8000;
      for (let i = 0; i < u8.length; i += C) s += String.fromCharCode.apply(null, u8.subarray(i, i + C));
      return btoa(s);
    };
    // Linear HDR scene, pre-postfx. readPixels is bottom-up; flip to image rows.
    g.render(1 / 120);
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt.fbo);
    const row = new Float32Array(rw * 4);
    const hdr = new Float32Array(rw * rh);
    for (let j = 0; j < rh; j++) {
      gl.readPixels(rx0, rt.h - 1 - (ry0 + j), rw, 1, gl.RGBA, gl.FLOAT, row);
      for (let i = 0; i < rw; i++) hdr[j * rw + i] = row[i * 4] * 0.2126 + row[i * 4 + 1] * 0.7152 + row[i * 4 + 2] * 0.0722;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // Final frame. preserveDrawingBuffer is off, so this must happen in the
    // same task as the render that produced it.
    g.render(1 / 120);
    const c = document.createElement('canvas'); c.width = rw; c.height = rh;
    const x2 = c.getContext('2d', { willReadFrequently: true });
    x2.drawImage(document.getElementById('gl'), rx0, ry0, rw, rh, 0, 0, rw, rh);
    const px = x2.getImageData(0, 0, rw, rh).data;
    const fin = new Float32Array(rw * rh);
    for (let i = 0; i < rw * rh; i++) fin[i] = px[i * 4] * 0.2126 + px[i * 4 + 1] * 0.7152 + px[i * 4 + 2] * 0.0722;
    return { hdr: b64(hdr), fin: b64(fin), rw, rh, info };
  }, DEPTH, { rx0: RX0, rx1: RX1, ry0: RY0, ry1: RY1 });
  await page.close();
  const de = (s) => new Float32Array(Buffer.from(s, 'base64').buffer.slice(0));
  return { hdr: de(got.hdr), fin: de(got.fin), rw: got.rw, rh: got.rh, info: got.info };
}

const A = await capture(EXTRA);
const B = MINUS === null ? null : await capture(MINUS);
await browser.close(); server.close();

const rw = A.rw;
const sub = (a, b) => { const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] - b[i]; return o; };

// ---------- detector ----------
const at = (L, x, y) => {
  const fx = x - RX0, fy = y - RY0;
  const ix = Math.floor(fx), iy = Math.floor(fy);
  if (ix < 0 || iy < 0 || ix + 1 >= rw || iy + 1 >= A.rh) return null;
  const tx = fx - ix, ty = fy - iy;
  const p = L[iy * rw + ix], q = L[iy * rw + ix + 1];
  const r = L[(iy + 1) * rw + ix], s = L[(iy + 1) * rw + ix + 1];
  return (p * (1 - tx) + q * tx) * (1 - ty) + (r * (1 - tx) + s * tx) * ty;
};

function detect(L, LVL, x0, x1) {
  const xc = (x0 + x1) / 2, n = x1 - x0 + 1;
  let level = 0, ln = 0;
  for (let y = Y0; y <= Y1; y++) for (let x = x0; x <= x1; x++) { const v = at(LVL, x, y); if (v !== null) { level += v; ln++; } }
  level /= Math.max(1, ln);

  const shear = (m, yr) => {
    let s = 0, k = 0;
    for (let x = x0; x <= x1; x++) { const v = at(L, x, yr + m * (x - xc)); if (v !== null) { s += v; k++; } }
    return k > n * 0.9 ? s / k : null;
  };

  // Full (slope, row) response grid, so per-row anisotropy is a by-product.
  const ms = [];
  for (let m = MLO; m <= MHI + 1e-9; m += MST) ms.push(m);
  const rows = [];
  for (let yr = Y0; yr <= Y1; yr++) {
    const r = new Float64Array(ms.length); let ok = 0;
    for (let i = 0; i < ms.length; i++) {
      const a = shear(ms[i], yr), lo = shear(ms[i], yr - GAP), hi = shear(ms[i], yr + GAP);
      if (a === null || lo === null || hi === null) { r[i] = NaN; continue; }
      r[i] = a - 0.5 * (lo + hi); ok++;
    }
    if (ok > ms.length * 0.5) rows.push({ yr, r });
  }
  const all = [], hits = [];
  for (const row of rows) {
    const fin = Array.from(row.r).filter((v) => Number.isFinite(v));
    const med = fin.map(Math.abs).sort((a, b) => a - b)[Math.floor(fin.length / 2)] || 1e-12;
    for (let i = 0; i < ms.length; i++) {
      if (!Number.isFinite(row.r[i])) continue;
      all.push(row.r[i]);
      hits.push({ m: ms[i], y: row.yr, r: row.r[i], aniso: row.r[i] / med });
    }
  }
  hits.sort((p, q) => q.r - p.r);

  // Coverage / constancy along the candidate. Only worth paying for on the
  // handful of candidates that survive non-maximum suppression.
  const profile = (m, yr) => {
    const c = [];
    for (let x = x0; x <= x1; x++) {
      const yy = yr + m * (x - xc);
      const a = at(L, x, yy), lo = at(L, x, yy - GAP), hi = at(L, x, yy + GAP);
      if (a === null || lo === null || hi === null) continue;
      c.push(a - 0.5 * (lo + hi));
    }
    if (!c.length) return { coverage: 0, cv: 9 };
    const mean = c.reduce((p, q) => p + q, 0) / c.length;
    if (mean <= 0) return { coverage: 0, cv: 9 };
    const sd = Math.sqrt(c.reduce((p, q) => p + (q - mean) * (q - mean), 0) / c.length);
    return { coverage: c.filter((v) => v > mean * 0.5).length / c.length, cv: sd / mean };
  };

  const nms = [];
  for (const h of hits) {
    if (nms.some((p) => Math.abs(p.y - h.y) < 3 * GAP && Math.abs(p.m - h.m) < 0.12)) continue;
    nms.push(h);
    if (nms.length >= 24) break;
  }
  for (const h of nms) Object.assign(h, profile(h.m, h.y));

  const sorted = all.map(Math.abs).sort((a, b) => a - b);
  const q = (t) => sorted[Math.min(sorted.length - 1, Math.floor(t * sorted.length))] || 1e-12;
  const lineLike = nms.filter((h) => h.aniso >= MIN_ANISO && h.coverage >= MIN_COV);
  return { level, peaks: nms.slice(0, TOPK), lines: lineLike.slice(0, TOPK), floor: q(0.5), x: [x0, x1] };
}

function shape(d, p) {
  if (!p) return null;
  return {
    slope: +p.m.toFixed(3), y: p.y, excursion: +p.r.toPrecision(4),
    rel: +(p.r / d.level).toFixed(4), aniso: +p.aniso.toFixed(2),
    coverage: +p.coverage.toFixed(2), cv: +p.cv.toFixed(2),
  };
}

function run(name, L, LVL, unit) {
  const tiles = [];
  for (let t = 0; t < TILES; t++) {
    const step = TILES > 1 ? Math.floor(TILEW / 2) : 0;
    const x0 = X0 + t * step;
    const x1 = TILES > 1 ? Math.min(X1, x0 + TILEW - 1) : X1;
    if (x1 - x0 < 24) continue;
    tiles.push(detect(L, LVL, x0, x1));
  }
  const rank = (k) => [...tiles].sort((a, b) => (b[k][0] ? b[k][0].r : 0) - (a[k][0] ? a[k][0].r : 0));
  const byAny = rank('peaks'), byLine = rank('lines');
  const bAny = byAny[0], bLine = byLine.find((t) => t.lines.length) || null;
  return {
    name, unit,
    level: +bAny.level.toPrecision(4),
    grainFloor: +bAny.floor.toPrecision(3),
    strongestFeature: { x: bAny.x, ...shape(bAny, bAny.peaks[0]), lineOverFloor: +(bAny.peaks[0].r / bAny.floor).toFixed(2) },
    strongestLine: bLine ? { x: bLine.x, ...shape(bLine, bLine.lines[0]), lineOverFloor: +(bLine.lines[0].r / bLine.floor).toFixed(2) } : null,
    perTile: tiles.map((t) => ({
      x: t.x,
      any: shape(t, t.peaks[0]),
      line: t.lines.length ? shape(t, t.lines[0]) : null,
    })),
  };
}

const hdrL = B ? sub(A.hdr, B.hdr) : A.hdr;
const finL = B ? sub(A.fin, B.fin) : A.fin;
const out = {
  seed: SEED, depth: DEPTH, size: `${W}x${H}`,
  captured: EXTRA || '(stock)', minus: MINUS === null ? null : (MINUS || '(stock)'),
  isolating: MINUS === null ? null : `${EXTRA || 'stock'} MINUS ${MINUS || 'stock'}`,
  window: { x: [X0, X1], y: [Y0, Y1] }, tiles: TILES, gap: GAP,
  speed: A.info && A.info.speed, reached: A.info && A.info.depth,
  hdrScene: run('linear HDR scene (pre-postfx)', hdrL, A.hdr, 'linear'),
  finalFrame: run('final frame', finL, A.fin, 'code (0-255)'),
  errors: errs,
};
if (JSON_OUT) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`seed ${SEED}  ${DEPTH}m  ${W}x${H}  speed=${out.speed}  reached=${out.reached}m`);
  console.log(`captured ?${out.captured}${out.minus === null ? '' : `   MINUS ?${out.minus}  (isolating the difference)`}`);
  console.log(`window x ${X0}-${X1} y ${Y0}-${Y1}, ${TILES} tile(s), arm ${GAP}px, slopes ${MLO}..${MHI}/${MST}`);
  console.log(`line gates: aniso >= ${MIN_ANISO}, coverage >= ${MIN_COV}`);
  const fmt = (s) => s ? `slope ${String(s.slope).padStart(6)}  y ${String(s.y).padStart(3)}  exc ${String(s.excursion).padStart(10)}  rel ${String(s.rel).padStart(8)}  aniso ${String(s.aniso).padStart(6)}  cov ${String(s.coverage).padStart(4)}  cv ${s.cv}` : '(none)';
  for (const d of [out.hdrScene, out.finalFrame]) {
    console.log(`\n${d.name}  [${d.unit}]   window level ${d.level}   grain floor ${d.grainFloor}`);
    console.log(`  strongest feature  x ${d.strongestFeature.x[0]}-${d.strongestFeature.x[1]}  ${fmt(d.strongestFeature)}`);
    console.log(`  STRONGEST LINE     ${d.strongestLine ? `x ${d.strongestLine.x[0]}-${d.strongestLine.x[1]}  ` + fmt(d.strongestLine) : 'NONE - no candidate passed the line gates'}`);
    if (TILES > 1) for (const t of d.perTile) {
      console.log(`    tile x ${String(t.x[0]).padStart(4)}-${String(t.x[1]).padStart(4)}  any: ${fmt(t.any)}`);
      console.log(`                      line: ${fmt(t.line)}`);
    }
  }
  if (errs.length) console.log('\nERRORS:\n  ' + errs.join('\n  '));
}
