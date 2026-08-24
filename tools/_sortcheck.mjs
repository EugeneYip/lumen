// Asserts every world list is globally sorted by x. Temporary verification.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import puppeteer from 'puppeteer';
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const MIME={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript'};
const server=createServer(async(q,r)=>{try{let p=new URL(q.url,'http://x').pathname;if(p.endsWith('/'))p+='index.html';
 const f=join(ROOT,normalize(p));if((await stat(f)).isDirectory())throw 0;const b=await readFile(f);
 r.writeHead(200,{'Content-Type':MIME[extname(f)]||'application/octet-stream','Cache-Control':'no-store'});r.end(b);}
 catch{r.writeHead(404).end('404');}});
await new Promise(r=>server.listen(0,r));
const PORT=server.address().port;
const b=await puppeteer.launch({headless:true,args:['--no-sandbox','--mute-audio']});
let bad = 0;
for (const seed of [7,3,11,42,99]) {
  const page=await b.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/?headless=1&seed=${seed}`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction('window.LUMEN&&window.LUMEN.ready===true',{timeout:40000,polling:50});
  const out = await page.evaluate(() => {
    const w = window.game.world;
    w.populate(40000);
    const res = {};
    for (const k of ['anchors','hazards','plankton','decor']) {
      let inv = 0, worst = 0;
      const a = w[k];
      for (let i = 1; i < a.length; i++) {
        if (a[i].x < a[i-1].x) { inv++; worst = Math.max(worst, a[i-1].x - a[i].x); }
      }
      res[k] = { n: a.length, inv, worst: +worst.toFixed(1) };
    }
    return res;
  });
  const line = Object.entries(out).map(([k,v]) => `${k} ${v.n}/${v.inv}`).join('  ');
  const seedBad = Object.values(out).some(v => v.inv > 0);
  if (seedBad) bad++;
  console.log(`seed ${String(seed).padStart(2)}  ${line}${seedBad ? '   <-- INVERSIONS' : ''}`);
  await page.close();
}
await b.close(); server.close();
console.log(bad ? `\nFAIL: ${bad} seed(s) have x-inversions` : '\nOK: all lists globally sorted on all seeds');
process.exit(bad ? 1 : 0);
