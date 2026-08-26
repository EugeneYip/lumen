#!/usr/bin/env node
/**
 * SCRATCH. Per-pixel sRGB delta between a reference PNG and one or more others.
 *
 *   node tools/_dif.mjs <ref.png> <b.png> [c.png ...]
 *
 * Reports the peak delta and, more usefully, the COUNT of pixels a layer moves
 * by at least 2 / 4 / 8 display levels. A layer whose 99th-percentile delta is
 * one level is not in the frame however good its shape is; that is the failure
 * mode this exists to price. HUD rows are excluded (top 150px, bottom 90px).
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const files = process.argv.slice(2).filter(a => !a.startsWith('--'));
if (files.length < 2) { console.error('usage: _dif.mjs <ref.png> <png> [png...]'); process.exit(2); }

const server = createServer(async (q, r) => {
  if (q.url === '/') { r.writeHead(200, { 'content-type': 'text/html' }); return r.end('<canvas id=a></canvas><canvas id=b></canvas>'); }
  try {
    const f = join(ROOT, normalize(decodeURIComponent(new URL(q.url, 'http://x').pathname)));
    await stat(f); r.writeHead(200, { 'content-type': 'image/png' }); r.end(await readFile(f));
  } catch { r.writeHead(404); r.end(); }
});
await new Promise((res) => server.listen(0, res));
const port = server.address().port;
const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${port}/`);

console.log('\n  file                                   maxD   p99.9   n>=2     n>=4    n>=8   meanL%');
for (const f of files.slice(1)) {
  const v = await page.evaluate(async (u0, u1) => {
    const load = async (u) => { const i = new Image(); i.src = u; await i.decode(); return i; };
    const A = await load(u0), B = await load(u1);
    const ca = document.getElementById('a'), cb = document.getElementById('b');
    ca.width = cb.width = A.width; ca.height = cb.height = A.height;
    const ga = ca.getContext('2d'), gb = cb.getContext('2d');
    ga.drawImage(A, 0, 0); gb.drawImage(B, 0, 0);
    const Y0 = 150, Y1 = A.height - 90;
    const da = ga.getImageData(0, Y0, A.width, Y1 - Y0).data;
    const db = gb.getImageData(0, Y0, A.width, Y1 - Y0).data;
    const hist = new Float64Array(256);
    let mx = 0, n2 = 0, n4 = 0, n8 = 0, sa = 0, sb = 0, tot = 0;
    for (let i = 0; i < da.length; i += 4) {
      const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
      if (d > mx) mx = d;
      if (d >= 2) n2++; if (d >= 4) n4++; if (d >= 8) n8++;
      hist[d]++; tot++;
      sa += 0.2126 * da[i] + 0.7152 * da[i + 1] + 0.0722 * da[i + 2];
      sb += 0.2126 * db[i] + 0.7152 * db[i + 1] + 0.0722 * db[i + 2];
    }
    let acc = 0, p999 = 0;
    for (let k = 255; k >= 0; k--) { acc += hist[k]; if (acc >= tot * 0.001) { p999 = k; break; } }
    return { mx, p999, n2, n4, n8, dmean: (sb - sa) / sa * 100 };
  }, `http://127.0.0.1:${port}/${files[0]}`, `http://127.0.0.1:${port}/${f}`);
  const nm = f.split('/').slice(-2).join('/');
  console.log(`  ${nm.padEnd(36)} ${String(v.mx).padStart(5)}  ${String(v.p999).padStart(5)}  ${String(v.n2).padStart(7)}  ${String(v.n4).padStart(7)} ${String(v.n8).padStart(7)}  ${v.dmean >= 0 ? '+' : ''}${v.dmean.toFixed(2)}`);
}
console.log('');
await browser.close(); server.close();
