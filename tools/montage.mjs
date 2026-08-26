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
import { createHash } from 'node:crypto';
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
    if (p === '/__blank') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>blank</title>');
      return;
    }
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
  // The page needs a real http origin before setContent, or the img loads below
  // never happen and every output is silently black.
  await page.goto(`http://127.0.0.1:${PORT}/__blank`, { waitUntil: 'domcontentloaded' });
  await page.setContent(html, { waitUntil: 'load' });
  const broken = await page.evaluate(async () => {
    const imgs = Array.from(document.images);
    await Promise.all(imgs.map((i) => (i.complete ? 1 : i.decode().catch(() => 1))));
    return imgs.filter((i) => !i.naturalWidth).length;
  });
  if (broken) {
    console.error(`${broken} image(s) failed to load; refusing to write a blank ${out}`);
    process.exit(3);
  }
  await page.screenshot({ path: out });
  await assertNotBlank(out);
}

/**
 * Refuse to claim success for an all-black output. Every silent failure this
 * tooling has had ended as a black PNG plus an OK line, and a review workflow
 * built on looking at pixels cannot afford that.
 */
async function assertNotBlank(file) {
  const buf = await readFile(file);
  // Cheap proxy: a PNG of a uniform field compresses far smaller than any real
  // frame at these dimensions.
  if (buf.length < 6000) {
    console.error(`${file} is ${buf.length} bytes - almost certainly blank. Refusing to report success.`);
    process.exit(3);
  }
}

const SHELL = (body, w, h) => `<!doctype html><meta charset=utf-8><style>
 *{margin:0;padding:0;box-sizing:border-box}
 html,body{width:${w}px;height:${h}px;background:#000;overflow:hidden}
 /* THE TWO HALVES MUST SIT ON AN EXACT TOTAL/2 PITCH. They did not: the
    divider used to take layout space, so cellW = (TOTAL - 3) / 2 was 1198.5 at
    a 2400 total -- a FRACTIONAL cell width, putting the right frame at a 1201.5px
    pitch while every critic brief tells the reviewer to crop at 1200. A blind
    reviewer measured the offset at +2px, retracted three verdicts it had already
    written, and said "I read ruled straight stalks on one side and curved on the
    other at 4x -- that was my crops being 2px out of registration". A systematic
    shift manufactures a difference in every fine detail in the frame, which is
    the exact class of defect these pairs exist to detect.
    The divider is now painted OVER the seam and takes no layout space, so each
    half is exactly TOTAL/2 and a reviewer's crop arithmetic is correct. */
 .wrap{display:flex;width:100%;height:100%;position:relative}
 .cell{position:relative;width:50%;height:100%;overflow:hidden;flex:0 0 50%}
 .cell img{display:block;width:100%;height:100%;object-fit:contain}
 .seam{position:absolute;left:50%;top:0;width:3px;height:100%;
       margin-left:-1.5px;background:#fff2;pointer-events:none}
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

  /**
   * Balanced assignment, not independent coin flips.
   *
   * Flipping each pair independently put the same build on the same side in all
   * four pairs of one review -- a 1-in-8 outcome that duly happened. The critic
   * noticed, and correctly warned that if the sides HAD been swapped its four
   * verdicts would have been split across two builds and the aggregate score
   * meaningless. With a handful of pairs, chance is not good enough: assign
   * exactly half to each side and shuffle that assignment.
   */
  const balancedFlips = (n) => {
    const f = Array.from({ length: n }, (_, i) => i < Math.floor(n / 2));
    for (let i = n - 1; i > 0; i--) {            // Fisher-Yates, seeded
      const j = Math.floor(rnd() * (i + 1));
      [f[i], f[j]] = [f[j], f[i]];
    }
    return f;
  };
  await mkdir(OUT, { recursive: true });

  const fa = await pngs(A), fb = await pngs(B);
  // Pair by moment, not by index: a mismatched list would otherwise compare a
  // launch frame against a title frame.
  //
  // The tag must survive BOTH naming schemes this harness emits:
  //   frame-03-fast.png   (named scene)   -> "fast"
  //   frame-00002s.png    (sim seconds)   -> "00002s"
  //   frame-00450m.png    (metres)        -> "00450m"
  // A previous version stripped /^frame-\d*-?/, which turned every one of the
  // second form into the single tag "s". All five frames of a run collapsed to
  // one key, so one build contributed one frame pasted into every pair, and an
  // entire critic round was spent reviewing the same image four times.
  const tag = (f) => {
    const b = basename(f, '.png');
    const named = b.match(/^frame-\d+-(.+)$/);
    if (named) return named[1];
    const plain = b.match(/^frame-(.+)$/);
    return plain ? plain[1] : b;
  };

  const dupes = (files, label) => {
    const seen = new Map();
    for (const f of files) {
      const t = tag(f);
      if (seen.has(t)) {
        console.error(`${label}: "${f}" and "${seen.get(t)}" both reduce to the tag "${t}".`);
        console.error('Pairing by tag would silently drop one of them. Fix the tag rule.');
        process.exit(4);
      }
      seen.set(t, f);
    }
  };
  dupes(fa, arg('a'));
  dupes(fb, arg('b'));

  const mapB = new Map(fb.map(f => [tag(f), f]));
  const pairs = fa.map(f => [f, mapB.get(tag(f))]).filter(([, b]) => b);
  const n = pairs.length;
  if (!n) {
    console.error(`no comparable frames (A: ${fa.map(tag).join(',')} | B: ${fb.map(tag).join(',')})`);
    process.exit(1);
  }
  if (n < Math.min(fa.length, fb.length)) {
    console.error(`only ${n} of ${Math.min(fa.length, fb.length)} frames paired -- the two runs do not cover the same moments.`);
    console.error(`  A: ${fa.map(tag).join(', ')}`);
    console.error(`  B: ${fb.map(tag).join(', ')}`);
    process.exit(4);
  }

  // A build contributing the same image to several pairs is the failure mode
  // that cost a whole review round, so check the bytes rather than the names.
  const sums = new Map();
  for (const [dir, files] of [[A, fa], [B, fb]]) {
    for (const f of files) {
      const h = createHash('sha1').update(await readFile(join(dir, f))).digest('hex');
      const key = dir + '|' + h;
      if (sums.has(key)) {
        console.error(`${join(dir, f)} is byte-identical to ${join(dir, sums.get(key))}.`);
        console.error('Two pairs would show the same image. Re-capture before reviewing.');
        process.exit(4);
      }
      sums.set(key, f);
    }
  }

  const key = [];
  const flips = balancedFlips(n);
  for (let i = 0; i < n; i++) {
    const [af, bf] = pairs[i];
    const scene = tag(af);
    const flip = flips[i];
    const left = flip ? join(B, bf) : join(A, af);
    const right = flip ? join(A, af) : join(B, bf);
    // assume 16:9 sources; the cell keeps aspect via object-fit anyway
    const cellW = TOTAL / 2, cellH = Math.round(cellW * 9 / 16);
    const html = SHELL(`<div class=wrap>
      <div class=cell><img src="${rel(left)}"><div class=tag>LEFT</div></div>
      
      <div class=cell><img src="${rel(right)}"><div class=tag>RIGHT</div></div>
      <div class=seam></div>
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
