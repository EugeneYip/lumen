#!/usr/bin/env node
// Scratch runner for tools/_grade.html.
//   node tools/_grade.mjs shots/grade "idle:1,idle:0.15,idle:5,fast:1,hush:1,launch:1"
import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = '/Users/eugene/Desktop/light';
const OUT = join(ROOT, process.argv[2] || 'shots/grade');
const CASES = (process.argv[3] || 'idle:1').split(',').map(s => s.trim()).filter(Boolean);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8' };
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
await new Promise(r => server.listen(0, r));
const PORT = server.address().port;
await mkdir(OUT, { recursive: true });

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--hide-scrollbars'] });
const page = await browser.newPage();
const errs = [];
page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
page.on('pageerror', e => errs.push('pageerror: ' + (e && e.message || e)));
await page.setViewport({ width: 1600, height: 900 });

for (const c of CASES) {
  const [state, mul, gover] = c.split(':');
  const url = `http://127.0.0.1:${PORT}/tools/_grade.html?state=${state}&mul=${mul || 1}&g=${encodeURIComponent(gover || '')}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  try { await page.waitForFunction('window.__ready === true', { timeout: 25000, polling: 50 }); }
  catch { errs.push(c + ' never ready'); continue; }
  const ms = await page.evaluate(() => window.__ms);
  const name = `g-${state}-x${String(mul || 1).replace('.', '_')}${gover ? '-' + gover.replace(/[:.]/g, '_') : ''}.png`;
  await page.screenshot({ path: join(OUT, name), clip: { x: 0, y: 0, width: 1600, height: 900 } });
  console.log(`${name}   post ${ms.toFixed(2)}ms/frame`);
}
await browser.close();
server.close();
if (errs.length) { console.error('\nERRORS:\n' + errs.map(e => '  - ' + e).join('\n')); process.exit(1); }
console.log('OK -> ' + OUT);
