#!/usr/bin/env node
/** Crop a region of a PNG at 1:1 so detail survives review.
 *   node tools/crop.mjs shots/x/frame.png 400,200,800,450 shots/x/crop.png [zoom] */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, relative } from 'node:path';
import puppeteer from 'puppeteer';
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const [src, rect, out, zoomArg] = process.argv.slice(2);
const [rx, ry, rw, rh] = rect.split(',').map(Number);
const zoom = Number(zoomArg || 1);
const MIME = { '.html': 'text/html', '.png': 'image/png' };
const server = createServer(async (q, r) => {
  try { const f = join(ROOT, normalize(decodeURIComponent(new URL(q.url, 'http://x').pathname)));
    if ((await stat(f)).isDirectory()) throw 0; const b = await readFile(f);
    r.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); r.end(b);
  } catch { r.writeHead(404).end('404'); }
});
await new Promise(r => server.listen(0, r));
const PORT = server.address().port;
const url = '/' + relative(ROOT, resolve(src)).split(/[\\/]/).map(encodeURIComponent).join('/');
const b = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--hide-scrollbars'] });
const page = await b.newPage();
await page.setViewport({ width: Math.round(rw * zoom), height: Math.round(rh * zoom) });
await page.setContent(`<style>*{margin:0;padding:0}html,body{background:#000;overflow:hidden;
 width:${rw * zoom}px;height:${rh * zoom}px}img{position:absolute;left:${-rx * zoom}px;top:${-ry * zoom}px;
 transform:scale(${zoom});transform-origin:0 0;image-rendering:pixelated}</style>
 <img src="http://127.0.0.1:${PORT}${url}">`, { waitUntil: 'load' });
await page.evaluate(() => Promise.all([...document.images].map(i => i.complete ? 1 : i.decode().catch(() => 1))));
await page.screenshot({ path: resolve(out) });
await b.close(); server.close();
console.log('OK ->', out);
