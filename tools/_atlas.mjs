#!/usr/bin/env node
// Scratch runner: serve the repo, screenshot tools/_atlas.html pages.
import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import puppeteer from 'puppeteer';

// Derived, not hardcoded: this file used to carry an absolute path to the
// author's home directory, which silently pointed at a DIFFERENT checkout when
// run from a worktree and would have broken outright on relocation.
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const OUT = process.argv[2] || join(ROOT, 'shots/atlas');
const PAGES = (process.argv[3] || '0,1,3,4').split(',');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css' };
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
await page.setViewport({ width: 1200, height: 900 });

for (const pg of PAGES) {
  await page.goto(`http://127.0.0.1:${PORT}/tools/_atlas.html?page=${pg}`, { waitUntil: 'domcontentloaded' });
  try { await page.waitForFunction('window.__ready === true', { timeout: 20000, polling: 50 }); }
  catch (e) { errs.push('page ' + pg + ' never ready'); continue; }
  const ms = await page.evaluate(() => window.__genMs);
  await page.screenshot({ path: join(OUT, `atlas-p${pg}.png`), fullPage: true });
  console.log(`page ${pg}  buildAll ${ms.toFixed(1)}ms`);
}
await browser.close();
server.close();
if (errs.length) { console.error('\nERRORS:\n' + errs.map(e => '  - ' + e).join('\n')); process.exit(1); }
console.log('OK -> ' + OUT);
