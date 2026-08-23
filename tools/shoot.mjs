#!/usr/bin/env node
/**
 * Deterministic screenshot harness for LUMEN.
 *
 *   node tools/shoot.mjs --out shots/base --at 0,3,9,22,45 --w 1600 --h 900 --seed 7
 *
 * Options
 *   --out <dir>     output directory (created)            default shots/run
 *   --at  <list>    simulated seconds to capture          default 0,2,6,14,30
 *   --scenes <list> named moments instead of times:
 *                   title,tethered,launch,fast,hazardNear,hushNear,deep,dead
 *   --w --h         viewport size                         default 1600x900
 *   --dpr <n>       device pixel ratio                    default 1
 *   --seed <n>      world seed                            default 7
 *   --tag <s>       filename prefix                       default frame
 *   --url <s>       extra query string, e.g. "debug=1"
 *   --quiet         suppress per-shot log lines
 *
 * Boots its own static server on an ephemeral port, so many agents can run it
 * concurrently. Exits non-zero on any page error / console error / failed shot.
 */
import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = resolve(new URL('..', import.meta.url).pathname);

// ---------- args ----------
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const flag = (k) => argv.includes('--' + k);
const OUT   = resolve(ROOT, arg('out', 'shots/run'));
const AT    = String(arg('at', '0,2,6,14,30')).split(',').map(Number).filter(n => !Number.isNaN(n));
const SCENES = arg('scenes', null);
const W     = Number(arg('w', 1600)), H = Number(arg('h', 900));
const DPR   = Number(arg('dpr', 1));
const SEED  = Number(arg('seed', 7));
const TAG   = arg('tag', 'frame');
const EXTRA = arg('url', '');
const QUIET = flag('quiet');

// ---------- static server ----------
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.mjs':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json',
  '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.woff2':'font/woff2',
  '.glsl':'text/plain; charset=utf-8' };

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if ((await stat(file)).isDirectory()) throw 0;
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store', 'Content-Length': body.length });
    res.end(body);
  } catch { res.writeHead(404).end('404'); }
});
await new Promise(r => server.listen(0, r));
const PORT = server.address().port;

// ---------- browser ----------
await mkdir(OUT, { recursive: true });
// Default headless on this machine gets a real ANGLE/Metal context, which is
// ~orders faster than SwiftShader; SOFT=1 forces the software path if needed.
const SOFT = process.env.LUMEN_SOFT_GL === '1';
const browser = await puppeteer.launch({
  headless: true,
  args: [
    ...(SOFT ? ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--use-gl=angle'] : []),
    '--no-sandbox',
    '--hide-scrollbars',
    '--mute-audio',
    '--force-device-scale-factor=' + DPR,
    '--font-render-hinting=none',
  ],
});

const problems = [];
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: DPR });
const IGNORE = /favicon|Failed to load resource/i;
page.on('console', m => { if (m.type() === 'error' && !IGNORE.test(m.text())) problems.push('console: ' + m.text()); });
page.on('pageerror', e => problems.push('pageerror: ' + (e && e.message || e)));
page.on('requestfailed', r => { if (!IGNORE.test(r.url())) problems.push('requestfailed: ' + r.url()); });

const url = `http://127.0.0.1:${PORT}/?headless=1&seed=${SEED}${EXTRA ? '&' + EXTRA : ''}`;
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

try {
  await page.waitForFunction('window.LUMEN && window.LUMEN.ready === true', { timeout: 45000, polling: 50 });
} catch (e) {
  problems.push('LUMEN never became ready (45s). ' + (await page.evaluate(() => window.__LUMEN_BOOT_ERROR__ || '')));
}

const written = [];
if (!problems.some(p => p.startsWith('LUMEN never'))) {
  if (SCENES) {
    const list = SCENES.split(',').map(s => s.trim()).filter(Boolean);
    for (let i = 0; i < list.length; i++) {
      const sc = list[i];
      try {
        const info = sc === 'title'
          ? await page.evaluate(async () => await window.LUMEN.seekTo(0.001))
          : await page.evaluate(async (c) => await window.LUMEN.seekUntil(c, 60), sc);
        const name = `${TAG}-${String(i).padStart(2, '0')}-${sc}.png`;
        const file = join(OUT, name);
        await page.screenshot({ path: file });
        written.push({ t: sc, file, info });
        if (!QUIET) console.log(`  ${name}  ${info && info.summary ? info.summary : ''}`);
      } catch (e) {
        problems.push(`scene ${sc} failed: ${e.message}`);
      }
    }
  } else {
    for (const t of AT) {
      try {
        const info = await page.evaluate(async (t) => { return await window.LUMEN.seekTo(t); }, t);
        const name = `${TAG}-${String(t).padStart(5, '0')}s.png`;
        const file = join(OUT, name);
        await page.screenshot({ path: file });
        written.push({ t, file, info });
        if (!QUIET) console.log(`  ${name}  ${info && info.summary ? info.summary : ''}`);
      } catch (e) {
        problems.push(`shot t=${t}s failed: ${e.message}`);
      }
    }
  }
}

const meta = { url, seed: SEED, w: W, h: H, dpr: DPR, at: AT, written: written.map(x => x.file), problems,
  stats: written.map(x => ({ t: x.t, ...x.info })) };
await writeFile(join(OUT, 'meta.json'), JSON.stringify(meta, null, 2));

await browser.close();
server.close();

if (problems.length) {
  console.error('\nFAILED:\n' + problems.map(p => '  - ' + p).join('\n'));
  process.exit(1);
}
console.log(`\nOK  ${written.length} frames -> ${OUT}`);
