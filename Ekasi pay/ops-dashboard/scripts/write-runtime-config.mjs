import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const publicDir = path.join(root, 'public');
const out = path.join(publicDir, 'runtime-config.js');

function normalizeApiUrl(raw) {
  let value = String(raw ?? '').trim().replace(/\/$/, '');
  if (!value) return '';

  if (!/^https?:\/\//i.test(value)) {
    value = `https://${value}`;
  }

  try {
    const url = new URL(value);
    if (!url.hostname.includes('.')) {
      url.hostname = `${url.hostname}.onrender.com`;
    }
    return url.origin;
  } catch {
    return value;
  }
}

const configured =
  process.env.VITE_API_URL ||
  process.env.API_HOST ||
  'https://ekasi-pay-api.onrender.com';

const apiUrl = normalizeApiUrl(configured);
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
fs.writeFileSync(
  out,
  `window.__KASIPAY_API_URL__=${JSON.stringify(apiUrl)};\n`,
  'utf8',
);
console.info(`[ops runtime-config] ${apiUrl}`);
