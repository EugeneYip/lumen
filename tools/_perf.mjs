#!/usr/bin/env node
/** Per-pass GPU cost breakdown. Each pass is timed with gl.finish(), best-of-N. */
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
const W = Number(process.argv[3] || 1280), H = Number(process.argv[4] || 720);
const seed = Number(process.argv[2] || 3);
const b=await puppeteer.launch({headless:true,args:['--no-sandbox','--mute-audio']});
const page=await b.newPage(); await page.setViewport({width:W,height:H});
await page.goto(`http://127.0.0.1:${PORT}/?headless=1&seed=${seed}`,{waitUntil:'domcontentloaded'});
await page.waitForFunction('window.LUMEN&&window.LUMEN.ready===true',{timeout:40000,polling:50});
await page.evaluate(c=>window.LUMEN.seekUntil(c,60),'fast');
const out = await page.evaluate(() => {
  const g = window.game, gl = g.gl;
  const ctx = g.frameCtx(1/120);
  const best = (fn, n=6, inner=8) => {
    let m = Infinity;
    for (let r=0;r<n;r++){ const t=performance.now(); for(let i=0;i<inner;i++) fn(); gl.finish();
      m = Math.min(m, (performance.now()-t)/inner); }
    return +m.toFixed(3);
  };
  gl.finish();
  const bg = best(() => { g.post.beginScene(); g.bg.draw(ctx); });
  const bgScene = best(() => { g.post.beginScene(); g.bg.draw(ctx); g.scene.draw(ctx); });
  const full = best(() => g.render(1/120));
  const hud = best(() => g.hud.draw(ctx, 1/120));
  return { bg, scene: +(bgScene-bg).toFixed(3), post: +(full-bgScene-hud).toFixed(3), hud, full,
           res: gl.drawingBufferWidth + 'x' + gl.drawingBufferHeight };
});
console.log(`seed ${seed} @ ${out.res}`);
console.log(`  background  ${out.bg} ms`);
console.log(`  scene       ${out.scene} ms`);
console.log(`  post        ${out.post} ms`);
console.log(`  hud (2d)    ${out.hud} ms`);
console.log(`  full frame  ${out.full} ms`);
await b.close(); server.close();
