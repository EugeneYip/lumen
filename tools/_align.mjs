#!/usr/bin/env node
/**
 * Is a blind pair actually registered? Sweeps the horizontal offset between the
 * two halves of a montage composite and reports mean absolute difference at
 * each shift. **A correctly built pair minimises at shift 0.**
 *
 *   node tools/_align.mjs shots/cmpN/pair-06-s7-00400m.png
 *
 * Why this exists, and why it is in the repo rather than a scratch directory:
 * for its entire history `montage.mjs pair` put the two halves on a 1201.5px
 * pitch rather than 1200, because the divider took layout space and
 * (2400 - 3) / 2 is fractional. Every brief tells the reviewer LEFT is x 0-1200
 * and RIGHT is x 1200-2400, so every 1:1 and 4x crop comparison was **2px out of
 * registration** — which manufactures an apparent difference in every fine
 * detail in the frame, i.e. exactly the class of defect blind pairs exist to
 * detect. A reviewer found it, retracted three verdicts it had already written,
 * and observed that "the lesson from the ruled-diagonal that survived four
 * rounds applies to reviewers too."
 *
 * Measured then: 3.02 at shift 0, 0.945 at shift +2 — a clean minimum in the
 * wrong place. After the fix: 0.943 at shift 0. Run this whenever montage's
 * layout is touched, and before trusting a round that reports fine-detail
 * differences. A pair that does not minimise at 0 is not a comparison.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const file = process.argv[2];
if (!file) { console.error('usage: _align.mjs <composite.png>'); process.exit(2); }

const server = createServer(async (q, r) => {
  if (q.url === '/') { r.writeHead(200, { 'content-type': 'text/html' }); return r.end('<canvas id=c></canvas>'); }
  try {
    const p = join(ROOT, normalize(decodeURIComponent(new URL(q.url, 'http://x').pathname)));
    await stat(p); r.writeHead(200, { 'content-type': 'image/png' }); r.end(await readFile(p));
  } catch { r.writeHead(404); r.end(); }
});
await new Promise((res) => server.listen(0, res));
const port = server.address().port;

const b = await puppeteer.launch({ args: ['--no-sandbox'] });
const p = await b.newPage();
await p.goto(`http://127.0.0.1:${port}/`);
const v = await p.evaluate(async (url) => {
  const img = new Image(); img.src = url; await img.decode();
  const c = document.getElementById('c'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const W = img.width, H = img.height, half = Math.floor(W / 2);
  const d = g.getImageData(0, 0, W, H).data;
  const L = (x, y) => { const i = (y * W + x) * 4; return 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; };
  const out = [];
  for (let dx = -4; dx <= 4; dx++) {
    let s = 0, n = 0;
    // Interior only: the tag chips and the outer frame are not shared content.
    for (let y = Math.floor(H * 0.25); y < H * 0.75; y += 2)
      for (let x = 60; x < half - 60; x += 2) {
        const xr = half + x + dx; if (xr < half || xr >= W) continue;
        s += Math.abs(L(x, y) - L(xr, y)); n++;
      }
    out.push({ dx, mad: +(s / n).toFixed(3) });
  }
  return { W, H, half, out };
}, `http://127.0.0.1:${port}/${file}`);

console.log(`\n${file}\n  composite ${v.W}x${v.H}, half = ${v.half}`);
const best = v.out.reduce((a, o) => (o.mad < a.mad ? o : a), v.out[0]);
for (const o of v.out) console.log(`  shift ${String(o.dx).padStart(2)}px  meanAbsDiff ${String(o.mad).padStart(7)}${o.dx === best.dx ? '   <= minimum' : ''}`);
console.log(best.dx === 0
  ? '\n  REGISTERED — minimum at shift 0.\n'
  : `\n  *** MISREGISTERED by ${best.dx}px. This pair is not a comparison. ***\n`);
await b.close(); server.close();
