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
const page=await b.newPage(); await page.setViewport({width:1280,height:720});
await page.goto(`http://127.0.0.1:${PORT}/?headless=1&seed=7`,{waitUntil:'domcontentloaded'});
await page.waitForFunction('window.LUMEN&&window.LUMEN.ready===true',{timeout:40000,polling:50});
const out = await page.evaluate(() => {
  const g = window.game;
  g.input.setSynthetic(false); g.input.endFrame(); g.startPlay();
  for (let i=0;i<400;i++){ g.input.setSynthetic(g.autopilot()); g.step(1/120); g.input.endFrame(); }
  const hash = () => {
    g.render(1/120);
    const t=document.createElement('canvas'); t.width=160; t.height=90;
    const x=t.getContext('2d',{willReadFrequently:true});
    x.drawImage(document.getElementById('gl'),0,0,160,90);
    const d=x.getImageData(0,0,160,90).data;
    let h=2166136261; for(let i=0;i<d.length;i++){h^=d[i];h=Math.imul(h,16777619);}
    return (h>>>0).toString(16);
  };
  return [hash(),hash(),hash(),hash(),hash()];
});
console.log('5 renders, frozen state:', out.join(' '));
console.log(new Set(out).size === 1 ? 'STABLE' : `VARIES (${new Set(out).size} distinct)`);
await b.close(); server.close();
