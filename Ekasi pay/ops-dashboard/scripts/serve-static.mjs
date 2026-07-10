/**
 * Minimal static file server for Render when ops-dashboard runs as a Node web
 * service (startCommand: npm start). Prefer a Static Site when possible.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, '..', 'dist');
const port = Number(process.env.PORT || 8790);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': status === 200 ? 'public, max-age=60' : 'no-store',
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, JSON.stringify({ ok: true, service: 'ekasi-ops-dashboard' }), 'application/json');
  }

  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0] || '/');
  // Never SPA-fallback API paths — that caused fake 200 HTML logins and missing tokens.
  if (urlPath === '/api' || urlPath.startsWith('/api/')) {
    return send(
      res,
      404,
      JSON.stringify({
        error:
          'This is the ops static host. API calls must go to ekasi-pay-api (check runtime-config.js).',
      }),
      'application/json',
    );
  }

  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(dist, safe === path.sep ? 'index.html' : safe);

  if (!filePath.startsWith(dist)) {
    return send(res, 403, 'Forbidden', 'text/plain');
  }

  fs.stat(filePath, (err, st) => {
    if (!err && st.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        // SPA fallback
        return fs.readFile(path.join(dist, 'index.html'), (idxErr, indexData) => {
          if (idxErr) {
            return send(res, 404, 'Not found — run npm run build first.', 'text/plain');
          }
          return send(res, 200, indexData, 'text/html; charset=utf-8');
        });
      }
      const ext = path.extname(filePath).toLowerCase();
      return send(res, 200, data, MIME[ext] || 'application/octet-stream');
    });
  });
});

server.listen(port, () => {
  console.info(`[ops] serving ${dist} on :${port}`);
});
