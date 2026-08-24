#!/usr/bin/env node
/**
 * Image compositing for review. Two modes.
 *
 * BLIND PAIR — for a harsh critic to judge two builds without knowing which is which:
 *   node tools/montage.mjs pair --a shots/base --b shots/cand --out shots/cmp
 *   -> shots/cmp/pair-00-<scene>.png  (LEFT | RIGHT, randomised per pair)
 *   -> shots/cmp/key.json             (the mapping — do NOT show the critic)
 *
 * SHEET — contact sheet of one run:
 *   node tools/montage.mjs sheet --dir shots/cand --out shots/cand/sheet.png
 *
 * Options: --width <px> total output width (default 2400 pair / 2000 sheet)
 *          --seed <n>   randomisation seed for pair side assignment
 */
import { createServer } from 'node:http';
import { readFile, readdir, mkdir, writeFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, basename, relative, isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const argv = process.argv.slice(2);
const MODE = argv[0];
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const f = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    const b = await readFile(f);
    res.writeHead(200, { 'Content-Type': MIME[extname(f).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store', 'Content-Length': b.length });
    res.end(b);
  } catch { res.writeHead(404).end('404'); }
});
await new Promise(r => server.listen(0, r));
const PORT = server.address().port;

const pngs = async (dir) => (await readdir(dir)).filter(f => f.endsWith('.png') && f !== 'sheet.png').sort();
/**
 * Images are served over a local static server rooted at the repo, so a path
 * outside it resolves to a 404 and the screenshot comes out black -- while the
 * tool still prints OK and exits 0. For a workflow whose central rule is "look
 * at the pixels", a pixel tool that silently outputs black is the worst
 * possible failure, so refuse it loudly instead.
 */
function repoRelative(pth, label) {
  const abs = resolve(pth);
  const rel = relative(ROOT, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    console.error(`${label} must be inside the repository (${ROOT}); got ${abs}`);
    process.exit(2);
  }
  if (!existsSync(abs)) {
    console.error(`${label} does not exist: ${abs}`);
    process.exit(2);
  }
  return '/' + rel.split(/[\\/]/).map(encodeURIComponent).join('/');
}
const rel = (p) => repoRelative(p, 'image');

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--hide-scrollbars', '--font-render-hinting=none'] });
const page = await browser.newPage();

async function shoot(html, w, h, out) {
  await page.setViewport({ width: Math.round(w), height: Math.round(h), deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => Promise.all(Array.from(document.images).map(i => i.complete ? 1 : i.decode().catch(() => 1))));
  await page.screenshot({ path: out });
}

const SHELL = (body, w, h) => `<!doctype html><meta charset=utf-8><style>
 *{margin:0;padding:0;box-sizing:border-box}
 html,body{width:${w}px;height:${h}px;background:#000;overflow:hidden}
 .wrap{display:flex;width:100%;height:100%}
 .cell{position:relative;flex:1;height:100%;overflow:hidden}
 .cell img{display:block;width:100%;height:100%;object-fit:contain}
 .tag{position:absolute;left:0;top:0;padding:7px 16px;background:#000c;
   font:600 15px/1 -apple-system,"SF Pro Display",Helvetica,sans-serif;letter-spacing:.28em;color:#fff}
 .div{width:3px;height:100%;background:#fff2;flex:0 0 3px}
 .grid{display:grid;width:100%;height:100%;background:#000;gap:3px}
 .g{position:relative;overflow:hidden}
 .g img{width:100%;height:100%;object-fit:contain;display:block}
 .cap{position:absolute;left:0;bottom:0;padding:5px 11px;background:#000b;
   font:500 12px/1 -apple-system,Helvetica,sans-serif;letter-spacing:.16em;color:#bfe8ff}
</style>${body}`;



if (MODE === 'pair') {
  const A = resolve(ROOT, arg('a')), B = resolve(ROOT, arg('b'));
  const OUT = resolve(ROOT, arg('out', 'shots/cmp'));
  const TOTAL = Number(arg('width', 2400));
  // Default derived from the inputs, not the clock, so a blind pairing can be
  // reproduced later from the same two directories.
  let seed = Number(arg('seed', [...`${A}|${B}`].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7) >>> 1)) | 0;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  await mkdir(OUT, { recursive: true });

  const fa = await pngs(A), fb = await pngs(B);
  // Pair by scene name, not by index: a mismatched scene list would otherwise
  // silently compare a launch frame against a title frame.
  const tag = (f) => basename(f, '.png').replace(/^frame-\d*-?/, '') || f;
  const mapB = new Map(fb.map(f => [tag(f), f]));
  const pairs = fa.map(f => [f, mapB.get(tag(f))]).filter(([, b]) => b);
  const n = pairs.length;
  if (!n) {
    console.error(`no comparable frames (A: ${fa.map(tag).join(',')} | B: ${fb.map(tag).join(',')})`);
    process.exit(1);
  }

  const key = [];
  for (let i = 0; i < n; i++) {
    const [af, bf] = pairs[i];
    const scene = tag(af);
    const flip = rnd() < 0.5;
    const left = flip ? join(B, bf) : join(A, af);
    const right = flip ? join(A, af) : join(B, bf);
    // assume 16:9 sources; the cell keeps aspect via object-fit anyway
    const cellW = (TOTAL - 3) / 2, cellH = Math.round(cellW * 9 / 16);
    const html = SHELL(`<div class=wrap>
      <div class=cell><img src="${rel(left)}"><div class=tag>LEFT</div></div>
      <div class=div></div>
      <div class=cell><img src="${rel(right)}"><div class=tag>RIGHT</div></div>
    </div>`, TOTAL, cellH);
    const out = join(OUT, `pair-${String(i).padStart(2, '0')}-${scene}.png`);
    await shoot(html, TOTAL, cellH, out);
    key.push({ file: basename(out), scene, LEFT: flip ? 'B' : 'A', RIGHT: flip ? 'A' : 'B',
      A: relative(ROOT, join(A, af)), B: relative(ROOT, join(B, bf)) });
    console.log(`  ${basename(out)}`);
  }
  await writeFile(join(OUT, 'key.json'), JSON.stringify({ A: relative(ROOT, A), B: relative(ROOT, B), pairs: key }, null, 2));
  console.log(`\nOK ${n} blind pairs -> ${OUT}\n(key.json written; do not reveal to the critic before it answers)`);
} else if (MODE === 'sheet') {
  const DIR = resolve(ROOT, arg('dir'));
  const OUT = resolve(ROOT, arg('out', join(DIR, 'sheet.png')));
  const TOTAL = Number(arg('width', 2000));
  const files = await pngs(DIR);
  if (!files.length) { console.error('no frames'); process.exit(1); }
  const cols = files.length <= 2 ? files.length : files.length <= 6 ? 2 : 3;
  const rows = Math.ceil(files.length / cols);
  const cellW = Math.floor((TOTAL - (cols - 1) * 3) / cols);
  const cellH = Math.round(cellW * 9 / 16);
  const H = rows * cellH + (rows - 1) * 3;
  const cells = files.map(f => `<div class=g><img src="${rel(join(DIR, f))}">
    <div class=cap>${basename(f, '.png').replace(/^frame-\d*-?/, '')}</div></div>`).join('');
  const html = SHELL(`<div class=grid style="grid-template-columns:repeat(${cols},1fr);grid-template-rows:repeat(${rows},1fr)">${cells}</div>`, TOTAL, H);
  await shoot(html, TOTAL, H, OUT);
  console.log(`OK sheet (${cols}x${rows}) -> ${OUT}`);
} else {
  console.error('usage: montage.mjs pair --a DIR --b DIR --out DIR | sheet --dir DIR [--out FILE]');
  process.exit(2);
}

await browser.close();
server.close();
