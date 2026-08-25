// Minimal static server. No deps. `node tools/serve.js [port]`
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = Number(process.argv[2] || process.env.PORT || 5173);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
  '.glsl': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    const s = await stat(file);
    if (s.isDirectory()) throw new Error('dir');
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Length': body.length,
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404');
  }
});

// This is the README's very first command, and an occupied port used to greet a
// newcomer with a raw unhandled EADDRINUSE stack trace. shoot.mjs already boots
// on an ephemeral port precisely so several agents can run at once, so the
// contention was known and simply not handled here.
//
// It does NOT silently move: a port you did not ask for is its own trap, and
// something is already serving on the one you did. It says what is wrong and
// what to do, and only auto-picks when explicitly told to with PORT=0.
server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  console.error(`lumen: port ${PORT} is already in use.`);
  console.error('  Something is already serving there -- possibly this game, from another session.');
  console.error(`  Open http://localhost:${PORT}/ and see, or start a second copy on another port:`);
  console.error('    node tools/serve.js 5174        # a port you choose');
  console.error('    PORT=0 node tools/serve.js      # any free port');
  process.exit(1);
});
server.listen(PORT, () => {
  const p = server.address().port;
  console.log(`lumen: http://localhost:${p}/`);
});
