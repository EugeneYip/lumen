#!/usr/bin/env node
// Scratch: find where the autopilot dies and dump the level around it.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import puppeteer from 'puppeteer';
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const SEED = Number(arg('seed', 7));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' };
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if ((await stat(f)).isDirectory()) throw 0;
    const b = await readFile(f);
    res.writeHead(200, { 'Content-Type': MIME[extname(f).toLowerCase()] || 'application/octet-stream', 'Content-Length': b.length });
    res.end(b);
  } catch { res.writeHead(404).end('404'); }
});
await new Promise(r => server.listen(0, r));
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--mute-audio'] });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/?headless=1&seed=${SEED}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.LUMEN && window.LUMEN.ready === true', { timeout: 45000, polling: 50 });
const out = await page.evaluate(() => {
  const g = window.game;
  g.input.setSynthetic(false); g.input.endFrame();
  g.startPlay();
  const track = [];
  for (let i = 0; i < 120 * 60; i++) {
    g.input.setSynthetic(g.autopilot()); g.step(1 / 120); g.input.endFrame();
    const p = g.player;
    if (i % 12 === 0) track.push([Math.round(p.x), Math.round(p.y), Math.round(p.speed), p.attached ? 1 : 0]);
    if (g.mode === 'dead') {
      const w = g.world;
      const X = p.x;
      const ph = w._phraseAt(X);
      return {
        cause: p.deathCause, x: Math.round(X), y: Math.round(p.y),
        vx: Math.round(p.vx), vy: Math.round(p.vy), t: +g.t.toFixed(2),
        band: [Math.round(w.bandTop(X)), Math.round(w.bandBot(X))],
        phrase: { kind: ph.kind, x0: Math.round(ph.x0), x1: Math.round(ph.x1), hazard: ph.hazard, line: ph.line },
        haz: w.hazards.filter(h => Math.abs(h.x - X) < 1300).map(h => ({
          k: h.kind === 1 ? 'urchin' : 'jelly', x: Math.round(h.x), y: Math.round(h.y),
          y0: h.y0 === undefined ? null : Math.round(h.y0), amp: h.amp ? Math.round(h.amp) : 0, r: Math.round(h.r),
          kill: Math.round(h.r * 0.62 + 15),
          top: Math.round(w.bandTop(h.x)), bot: Math.round(w.bandBot(h.x)),
        })),
        anc: w.anchors.filter(a => Math.abs(a.x - X) < 1300).map(a => ({
          x: Math.round(a.x), y: Math.round(a.y), r: Math.round(a.r), stalk: Math.round(a.stalk),
        })),
        tail: track.slice(-14),
      };
    }
  }
  return { cause: 'survived 60s', x: Math.round(g.player.maxX) };
});
await browser.close(); server.close();
console.log(JSON.stringify(out, null, 1));
