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
import { extname, join, normalize, resolve, basename, relative } from 'node:path';
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
const rel = (p) => '/' + relative(ROOT, resolve(p)).split(/[\\/]/).map(encodeURIComponent).join('/');

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--hide-scrollbars', '--font-render-hinting=none'] });
const page = await browser.newPage();

async function shoot(html, w, h, out) {
  await page.setViewport({ width: Math.round(w), height: Math.round(h), deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${PORT}/tools/_blank.html`, { waitUntil: 'domcontentloaded' });
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

await mkdir(join(ROOT, 'tools'), { recursive: true });
await writeFile(join(ROOT, 'tools/_blank.html'), '<!doctype html><title>b</title>');

if (MODE === 'pair') {
  const A = resolve(ROOT, arg('a')), B = resolve(ROOT, arg('b'));
  const OUT = resolve(ROOT, arg('out', 'shots/cmp'));
  const TOTAL = Number(arg('width', 2400));
  let seed = Number(arg('seed', Date.now() % 100000)) | 0;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  await mkdir(OUT, { recursive: true });

  const fa = await pngs(A), fb = await pngs(B);
  const n = Math.min(fa.length, fb.length);
  if (!n) { console.error('no comparable frames'); process.exit(1); }

  const key = [];
  for (let i = 0; i < n; i++) {
    const scene = basename(fa[i], '.png').replace(/^frame-\d*-?/, '') || String(i);
    const flip = rnd() < 0.5;
    const left = flip ? join(B, fb[i]) : join(A, fa[i]);
    const right = flip ? join(A, fa[i]) : join(B, fb[i]);
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
      A: relative(ROOT, join(A, fa[i])), B: relative(ROOT, join(B, fb[i])) });
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
