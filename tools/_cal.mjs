import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import puppeteer from 'puppeteer';
const ROOT = resolve('/Users/eugene/Desktop/light');
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
await page.goto(`http://127.0.0.1:${server.address().port}/?headless=1&seed=7`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.LUMEN && window.LUMEN.ready === true', { timeout: 45000, polling: 50 });
const out = await page.evaluate(async () => {
  const { Player, P } = await import('/src/game/player.js');
  const w = window.game.world;
  w.populate(40000);
  const anchors = w.anchors.slice().sort((a,b)=>a.x-b.x).filter(a => a.x > 1000 && a.x < 34000);
  const noop = () => {};
  const fx = { sparks:noop,burst:noop,ring:noop,bubbles:noop,shake:noop,flash:noop,slowmo:noop,wave:noop,sound:noop };
  const stub = { bandTop:(x)=>w.bandTop(x), bandBot:(x)=>w.bandBot(x), plankton:[], hazards:[], anchors:w.anchors, hushX:-1e9, pickAnchor:()=>null };
  const input = { held:true }; const DT = 1/120;
  const p = new Player();
  const realCarry = [], relSpeed = [], modelCarry = [], ratio = [];
  for (const A of anchors) {
    // best real carry over a hold sweep: how far forward before hitting the floor
    let bestCarry = 0, bestSpd = 0;
    for (let h = 0.2; h <= 1.6; h += 0.14) {
      p.reset();
      const rope0 = Math.min(P.ropeMax, 500);
      p.x = A.x - 0.35*rope0; p.y = A.y + 0.94*rope0;
      p.vx = 0.94*820; p.vy = 0.35*820;
      p.anchor = A; p.rope = rope0; p.holdTime = 0; p.sinceRelease = 99;
      const nH = Math.round(h/DT);
      input.held = true;
      for (let i=0;i<nH;i++) p.update(DT, stub, input, fx, i*DT);
      input.held = false;
      const spd = Math.hypot(p.vx, p.vy);
      let far = p.x;
      for (let i=0;i<Math.round(2.6/DT);i++) {
        p.update(DT, stub, input, fx, (nH+i)*DT);
        const bot = w.bandBot(p.x);
        if (p.y > bot - 40) break;             // on the floor: the flight is over
        if (p.x > far) far = p.x;
      }
      const carry = far - A.x;
      if (carry > bestCarry) { bestCarry = carry; bestSpd = spd; }
    }
    // world.js's own design-time arc, same start
    const d = w._trend(A.x);
    w._arc(A.x, A.y, d, A.x + 3000);
    const mc = w._arcBuf[(w._arcN-1)*2] - A.x;
    realCarry.push(bestCarry); relSpeed.push(bestSpd); modelCarry.push(mc);
    if (bestCarry > 40) ratio.push(mc / bestCarry);
  }
  const q = (arr,f) => { const s=arr.slice().sort((a,b)=>a-b); return Math.round(s[Math.floor(f*(s.length-1))]*100)/100; };
  return { n: anchors.length,
    realCarry:[q(realCarry,0.1),q(realCarry,0.5),q(realCarry,0.9)],
    modelCarry:[q(modelCarry,0.1),q(modelCarry,0.5),q(modelCarry,0.9)],
    relSpeed:[q(relSpeed,0.1),q(relSpeed,0.5),q(relSpeed,0.9)],
    ratio:[q(ratio,0.1),q(ratio,0.5),q(ratio,0.9)] };
});
await browser.close(); server.close();
console.log('anchors sampled', out.n);
console.log('real forward carry  p10/p50/p90 :', out.realCarry.join(' / '));
console.log('world.js arc carry  p10/p50/p90 :', out.modelCarry.join(' / '));
console.log('release speed       p10/p50/p90 :', out.relSpeed.join(' / '));
console.log('model/real ratio    p10/p50/p90 :', out.ratio.join(' / '), ' (>1 = arc is optimistic)');
