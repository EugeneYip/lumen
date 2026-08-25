#!/usr/bin/env node
/**
 * Ruled-hairline detector.
 *
 *   node tools/_hair.mjs shots/a/f.png shots/b/f.png ...
 *   node tools/_hair.mjs --region 920,100,300,220 shots/a/f.png ...
 *
 * A thin dark line crossing a horizontal scanline is a narrow NEGATIVE notch:
 * the pixel is darker than its neighbours a few columns to either side, while
 * those neighbours agree with each other. Broad shading gradients, vignette,
 * grain and bloom do not produce that signature; ruled lines do, and so do
 * genuine cracks — this instrument measures RULING, not correctness, so read it
 * next to the image.
 *
 * Why it exists: "a straight line nobody drew" has been the single most
 * expensive defect class in this project (see AI_HANDOFF §7 and the three shape
 * traps). It was found four separate times by eye, at 1:1 crops, after a
 * downscaled contact sheet hid it — and once only after four review rounds,
 * because the ablation statistic in use at the time was reporting grain. A
 * frame-wide mean cannot see a hairline. This can:
 *
 *   build                        notch   deep>3
 *   all background terms on      1.331     3540
 *   bgNoFar                      0.581      272     <- names the far walls
 *   bgNoSnow / bgNoRays /
 *   bgNoGrain / bgNoSilt         ~1.33    ~3540     <- within noise
 *
 * Pair it with the kill switches (`?noSprites=1`, `?noRibbons=1`, `?bgNo*=1`)
 * and bisect. Isolate by elimination, never by reasoning about the shader.
 *
 * Not a gate: it has no pass/fail contract, it is scale-dependent, and a rock
 * face SHOULD have some notch energy in it. Compare builds, not absolutes.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const ri = argv.indexOf('--region');
// Default region: right of centre, above the HUD readouts and below the title,
// which is far wall and open water in most captures.
const [RX, RY, RW, RH] = (ri < 0 ? '920,100,300,220' : argv[ri + 1]).split(',').map(Number);
const files = argv.filter((a, i) => (ri < 0 || (i !== ri && i !== ri + 1)) && !a.startsWith('--'));
if (!files.length) { console.error('usage: _hair.mjs [--region x,y,w,h] <png> [png...]'); process.exit(2); }

const server = createServer(async (q, r) => {
  if (q.url === '/') { r.writeHead(200, { 'content-type': 'text/html' }); return r.end('<canvas id=c></canvas>'); }
  try {
    const f = join(ROOT, normalize(decodeURIComponent(new URL(q.url, 'http://x').pathname)));
    await stat(f); r.writeHead(200, { 'content-type': 'image/png' }); r.end(await readFile(f));
  } catch { r.writeHead(404); r.end(); }
});
await new Promise((res) => server.listen(0, res));
const port = server.address().port;

const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
// Served from the same origin as the images, or getImageData taints.
await page.goto(`http://127.0.0.1:${port}/`);

console.log(`\nruled-hairline notch energy  region ${RX},${RY} ${RW}x${RH}\n`);
for (const f of files) {
  const v = await page.evaluate(async (url, X0, Y0, W, H) => {
    const img = new Image(); img.src = url; await img.decode();
    const c = document.getElementById('c'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    if (X0 + W > img.width || Y0 + H > img.height) return { err: `region outside ${img.width}x${img.height}` };
    const d = g.getImageData(X0, Y0, W, H).data;
    const L = (i, j) => { const k = (j * W + i) * 4; return 0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2]; };
    let sum = 0, n = 0, deep = 0;
    for (let j = 0; j < H; j++) for (let i = 4; i < W - 4; i++) {
      // Median of four neighbours straddling the line, so a 1-3px feature is
      // compared against rock that is not part of it. Excluding the immediate
      // neighbours is what keeps a soft gradient from registering.
      const s = [L(i - 4, j), L(i - 3, j), L(i + 3, j), L(i + 4, j)].sort((a, b) => a - b);
      const notch = (s[1] + s[2]) / 2 - L(i, j);
      if (notch > 0) { sum += notch; n++; if (notch > 3) deep++; }
    }
    return { mean: +(sum / Math.max(n, 1)).toFixed(3), deep };
  }, `http://127.0.0.1:${port}/${f}`, RX, RY, RW, RH);
  if (v.err) { console.log(`  ${f.padEnd(44)} ${v.err}`); continue; }
  console.log(`  ${f.padEnd(44)} notch ${String(v.mean).padStart(6)}   deep>3 ${String(v.deep).padStart(6)}`);
}
console.log('');
await browser.close(); server.close();
