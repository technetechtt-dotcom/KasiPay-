/**
 * Dev-only private storage signing stub.
 * Verifies HMAC from privateObjectStorage.ts and stores objects on local disk.
 *
 *   PRIVATE_STORAGE_SIGNING_SECRET=... node scripts/dev-private-storage-signer.mjs
 */
import { createHmac, createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const secret = process.env.PRIVATE_STORAGE_SIGNING_SECRET?.trim() ?? '';
if (secret.length < 32) {
  throw new Error('PRIVATE_STORAGE_SIGNING_SECRET (>=32 chars) is required.');
}
const port = Number(process.env.DEV_STORAGE_PORT ?? 8791);
const root = path.resolve(process.env.DEV_STORAGE_ROOT ?? '.tmp/private-storage');
mkdirSync(root, { recursive: true });

function verify(operation, key, expires, signature, contentType = '') {
  if (!Number.isFinite(Number(expires)) || Number(expires) < Date.now()) return false;
  const canonical = `${operation}\n${key}\n${expires}\n${contentType}`;
  const expected = createHmac('sha256', secret).update(canonical).digest('base64url');
  return expected === signature;
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const operation = url.searchParams.get('operation') ?? '';
    const key = url.searchParams.get('key') ?? '';
    const expires = url.searchParams.get('expires') ?? '';
    const signature = url.searchParams.get('signature') ?? '';
    const contentType = url.searchParams.get('contentType') ?? '';
    if (!key || key.includes('..') || key.startsWith('/') || !verify(operation, key, expires, signature, contentType)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const filePath = path.join(root, key);
    if (req.method === 'PUT' && operation === 'upload') {
      mkdirSync(path.dirname(filePath), { recursive: true });
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      writeFileSync(filePath, Buffer.concat(chunks));
      res.writeHead(201).end('stored');
      return;
    }
    if (req.method === 'GET' && operation === 'download') {
      if (!existsSync(filePath)) {
        res.writeHead(404).end('missing');
        return;
      }
      res.writeHead(200, { 'content-type': contentType || 'application/octet-stream' });
      res.end(readFileSync(filePath));
      return;
    }
    res.writeHead(405).end('method');
  } catch (error) {
    res.writeHead(500).end(error instanceof Error ? error.message : 'error');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ ok: true, port, root, endpoint: `http://127.0.0.1:${port}` }));
});
