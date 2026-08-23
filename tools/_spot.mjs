#!/usr/bin/env node
// Scratch: where the autopilot dies, and what the level looks like there.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import puppeteer from 'puppeteer';
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
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
for (const seed of String(arg('seeds', '19')).split(',')) {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/?headless=1&seed=${seed}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.LUMEN && window.LUMEN.ready === true', { timeout: 45000, polling: 50 });
  const o = await page.evaluate(() => {
    const g = window.game;
    g.input.setSynthetic(false); g.input.endFrame();
    g.startPlay();
    const tail = [];
    for (let i = 0; i < 120 * 90; i++) {
      g.input.setSynthetic(g.autopilot()); g.step(1 / 120); g.input.endFrame();
      const p = g.player;
      if (i % 10 === 0) tail.push([Math.round(p.x), Math.round(p.y), Math.round(p.speed), p.attached ? 'T' : '-']);
      if (g.mode === 'dead') {
        const w = g.world, X = p.x, ph = w._phraseAt(X);
        const near = (a) => Math.abs(a.x - X) < 1100;
        return { cause: p.deathCause, x: Math.round(X), y: Math.round(p.y), t: +g.t.toFixed(1),
          band: [Math.round(w.bandTop(X)), Math.round(w.bandBot(X))],
          ph: { kind: ph.kind, hazard: ph.hazard, line: ph.line, x0: Math.round(ph.x0), x1: Math.round(ph.x1) },
          haz: w.hazards.filter(near).map(h => ({ k: h.kind === 1 ? 'urch' : 'jelly', x: Math.round(h.x),
            y: Math.round(h.y), amp: h.amp ? Math.round(h.amp) : 0, r: Math.round(h.r),
            bot: Math.round(w.bandBot(h.x)), top: Math.round(w.bandTop(h.x)) })),
          anc: w.anchors.filter(near).map(a => ({ x: Math.round(a.x), y: Math.round(a.y), low: !!a.low })),
          tail: tail.slice(-9) };
      }
    }
    return { cause: 'survived 90s', x: Math.round(g.player.maxX) };
  });
  console.log(`\n===== seed ${seed}: ${o.cause} at x=${o.x} y=${o.y} t=${o.t}s  band=${JSON.stringify(o.band)}`);
  if (o.ph) {
    console.log('  phrase', JSON.stringify(o.ph));
    console.log('  anchors', o.anc.map(a => `${a.x},${a.y}${a.low ? 'L' : ''}`).join('  '));
    console.log('  hazards');
    for (const h of o.haz) console.log('   ', JSON.stringify(h));
    console.log('  approach', o.tail.map(t => t.join(',')).join('  '));
  }
  await page.close();
}
await browser.close(); server.close();
