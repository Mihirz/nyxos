// Tiny static server for the demo site: `npm run demo:site` → http://localhost:3000
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'acme-site');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const routes = { '/': 'index.html', '/signup': 'signup.html', '/thanks': 'thanks.html' };
  const file = routes[url.pathname] ?? url.pathname.slice(1);
  try {
    const body = await readFile(path.join(root, path.normalize(file)));
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'text/plain' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>404 Not Found</title><main><h1>404: page not found</h1><p>There is nothing at ' + url.pathname + '.</p><a href="/">Back home</a></main>');
  }
}).listen(3000, () => console.log('demo site on http://localhost:3000'));
