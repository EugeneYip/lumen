#!/usr/bin/env node
/**
 * Isolation rig (worktree-only scratch instrument).
 *
 * Renders ONE creature, alone, centred, at a fixed on-screen radius, with every
 * other world object removed and the player moved off-frame. It exists because
 * both regularity instruments were measured against a deliberately PERFECT
 * control - 17 identical spines at exactly even angles - and neither could tell
 * it from the shipped build. The reason is contamination: at 1600x900 an urchin
 * is ~100px across and the annulus a spectrum is taken over contains an anchor
 * stalk, an anemone colony and rock, all of which are larger signals than the
 * thing being measured. Isolate first, then measure.
 *
 *   node tools/_iso.mjs --seed 7 --kind urchin  --out shots/iso/a
 *   node tools/_iso.mjs --seed 3 --kind anemone --warm --out shots/iso/a
 *
 * Writes <out>/<seed>-<kind>-<i>.png plus a .json of the centre and radius in
 * pixels, which is what _ring.mjs needs.
 */
import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const SEED = Number(arg('seed', 7));
const KIND = arg('kind', 'urchin');
const WARM = argv.includes('--warm');
const COUNT = Number(arg('count', 3));
const RPX = Number(arg('rpx', 90));
const OUT = arg('out', 'shots/iso');
const W = 900, H = 900;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.png': 'image/png', '.json': 'application/json' };
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
await new Promise((r) => server.listen(0, r));
const PORT = server.address().port;

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--hide-scrollbars', '--mute-audio'] });
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
await page.goto(`http://127.0.0.1:${PORT}/?headless=1&seed=${SEED}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.LUMEN && window.LUMEN.ready === true', { timeout: 45000, polling: 50 });
await page.evaluate(async () => await window.LUMEN.seekUntil('hazardNear', 60));

const outDir = resolve(ROOT, OUT);
await mkdir(outDir, { recursive: true });

const picked = await page.evaluate((kind, warm, count) => {
  const g = window.LUMEN.game, w = g.world;
  const K = { ANCHOR: 0, URCHIN: 1, JELLY: 2, PLANKTON: 3, KELP: 4, SPIRE: 5, ANEMONE: 6 };
  let list;
  if (kind === 'urchin') list = w.hazards.filter((h) => h.alive && h.kind === K.URCHIN);
  else if (kind === 'jelly') list = w.hazards.filter((h) => h.alive && h.kind === K.JELLY);
  else list = w.decor.filter((d) => d.kind === K.ANEMONE && (warm ? d.hue === 0 : d.hue !== 0));
  // Biggest first: the defect is about visible construction, so measure where
  // there are pixels to see it in.
  list = list.slice().sort((a, b) => b.r - a.r).slice(0, count);
  window.__ISO = list.map((o) => ({ x: o.x, y: o.y, r: o.r }));
  return window.__ISO;
}, KIND, WARM, COUNT);

const meta = [];
for (let i = 0; i < picked.length; i++) {
  const info = await page.evaluate((idx, rpx) => {
    const g = window.LUMEN.game, w = g.world, cam = g.cam;
    const o = window.__ISO[idx];
    // Strip the world down to the one object. Lists must stay sorted by x
    // (world invariant 5) - a filtered list is still sorted, so this is safe.
    if (!window.__ISO_SAVE) {
      window.__ISO_SAVE = {
        decor: w.decor.slice(), hazards: w.hazards.slice(),
        plankton: w.plankton ? w.plankton.slice() : null, anchors: w.anchors.slice(),
        px: g.player.x, py: g.player.y, hushX: w.hushX,
      };
    }
    const S = window.__ISO_SAVE;
    const keepD = S.decor.filter((d) => d.x === o.x && d.y === o.y && d.r === o.r);
    const keepH = S.hazards.filter((h) => h.x === o.x && h.y === o.y && h.r === o.r);
    w.decor.length = 0; for (const d of keepD) w.decor.push(d);
    w.hazards.length = 0; for (const h of keepH) w.hazards.push(h);
    w.anchors.length = 0;
    if (w.plankton) w.plankton.length = 0;
    w.hushX = -1e9;
    // Player off-frame so the hero's halo does not land in the annulus.
    g.player.x = o.x + 90000; g.player.y = o.y;
    const ppu = rpx / o.r;
    cam.rot = 0; cam.zoom = (ppu * 1080) / cam.pixelH; cam._recalc();
    cam.x = o.x; cam.y = o.y;
    g.render(1 / 120);
    return { cx: cam.pixelW / 2, cy: cam.pixelH / 2, ppu, r: o.r, rpx: o.r * ppu, wx: o.x, wy: o.y };
  }, i, RPX);
  const name = `${SEED}-${KIND}${KIND === 'anemone' ? (WARM ? '-warm' : '-cold') : ''}-${i}.png`;
  await page.screenshot({ path: join(outDir, name) });
  // ...and the SAME camera with the creature also removed. Every statistic
  // taken over an annulus is otherwise measuring the trench as well as the
  // animal, and rock correlates with itself under rotation, which floors any
  // self-similarity number at whatever the background scores. Subtracting this
  // plate is the only way the annulus contains one object.
  await page.evaluate(() => {
    const w = window.LUMEN.game.world;
    w.decor.length = 0; w.hazards.length = 0;
    window.LUMEN.game.render(1 / 120);
  });
  await page.screenshot({ path: join(outDir, name.replace('.png', '-bg.png')) });
  meta.push({ file: `${OUT}/${name}`, ...info });
  console.log(`  ${OUT}/${name}   centre ${info.cx},${info.cy}  r ${info.rpx.toFixed(1)}px  (world r ${info.r.toFixed(1)} at ${info.wx.toFixed(0)},${info.wy.toFixed(0)})`);
}
await writeFile(join(outDir, `${SEED}-${KIND}${KIND === 'anemone' ? (WARM ? '-warm' : '-cold') : ''}.json`), JSON.stringify(meta, null, 2));
await browser.close();
server.close();
