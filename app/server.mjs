import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = new Map([
  ['/', ['app/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app/app.js', 'text/javascript; charset=utf-8']],
  ['/appearance.mjs', ['app/appearance.mjs', 'text/javascript; charset=utf-8']],
  ['/state.mjs', ['app/state.mjs', 'text/javascript; charset=utf-8']],
  ['/style.css', ['app/style.css', 'text/css; charset=utf-8']],
  ...['groq', 'stripe', 'github', 'neon', 'cloudflare', 'linear'].map(name => [`/brands/${name}.svg`, [`mockups/assets/brands/${name}.svg`, 'image/svg+xml']])
]);
const port = Number(process.env.PORT || 3000);
createServer(async (req, res) => {
  const entry = files.get(new URL(req.url, 'http://localhost').pathname);
  if (!entry || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404); res.end('Not found'); return; }
  try {
    const data = await readFile(resolve(root, entry[0]));
    res.writeHead(200, { 'Content-Type': entry[1], 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'" });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(port, '0.0.0.0', () => console.log(`Hasp development preview listening on ${port}`));
