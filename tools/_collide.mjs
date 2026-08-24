#!/usr/bin/env node
/**
 * Do two named scenes resolve to the same frame? `check.mjs` and `shoot.mjs`
 * seek the scene list in order without restarting, so a predicate that is
 * already true when the previous scene resolved is satisfied one step later and
 * the two moments are one frame. That halves A/B coverage and double-reports
 * every warning from it, and the numbers look plausible either way -- the only
 * way to see it is to print the sim time, the depth and a frame hash side by
 * side, which is what this does.
 *
 *   node tools/_collide.mjs [seeds] [scenes]
 *   node tools/_collide.mjs 7,3
 *   node tools/_collide.mjs 3,4,5,8,9,10,11 hushNear,deep
 *
 * Scenes are seeked in the order given, from one boot per seed, exactly as the
 * harness does it. Equal `hash` means literally the same image; a `simT` gap of
 * 0.008 is one fixed step, i.e. adjacent frames.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const SEEDS = String(process.argv[2] || '7,3').split(',').map(Number);
const SCENES = String(process.argv[3] || 'title,tethered,launch,fast').split(',');
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
  await page.goto(`http://127.0.0.1:${PORT}/?headless=1&seed=${seed}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction('window.LUMEN && window.LUMEN.ready === true', { timeout: 45000, polling: 50 });
  console.log(`\n=== seed ${seed} ===`);
  console.log('scene       simT      x      depth  speed  lGlow  att  hash        mean');
  for (const sc of SCENES) {
    const info = sc === 'title'
      ? await page.evaluate(() => window.LUMEN.seekTo(0.001))
      : await page.evaluate((c) => window.LUMEN.seekUntil(c, 60), sc);
    const extra = await page.evaluate(() => {
      const g = window.game;
      window.game.render(1 / 120);
      const src = document.getElementById('gl');
      const t = document.createElement('canvas');
      t.width = 192; t.height = 108;
      const x = t.getContext('2d', { willReadFrequently: true });
      x.drawImage(src, 0, 0, t.width, t.height);
      const d = x.getImageData(0, 0, t.width, t.height).data;
      let sum = 0, h = 2166136261;
      for (let i = 0; i < d.length; i += 4) {
        const l = (d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722) / 255;
        sum += l;
        h ^= d[i]; h = Math.imul(h, 16777619);
        h ^= d[i + 1]; h = Math.imul(h, 16777619);
        h ^= d[i + 2]; h = Math.imul(h, 16777619);
      }
      return { t: g.t, launchGlow: g.player.launchGlow, hash: (h >>> 0).toString(16),
        mean: sum / (t.width * t.height), attached: g.player.attached };
    });
    console.log(`${sc.padEnd(11)} ${extra.t.toFixed(3).padStart(7)} ${String(info.x).padStart(7)} ${String(info.depth).padStart(6)} ${String(info.speed).padStart(6)}  ${extra.launchGlow.toFixed(3)}  ${String(extra.attached).padEnd(5)} ${extra.hash.padStart(8)}  ${extra.mean.toFixed(6)}`);
  }
  await page.close();
}
await browser.close(); server.close();
