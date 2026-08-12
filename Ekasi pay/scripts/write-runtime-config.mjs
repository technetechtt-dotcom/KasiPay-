import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const out = path.join(root, 'public', 'runtime-config.js');

/** Pilot Help contact when Render/Vite env is unset. Email-only is enough. */
const DEFAULT_SUPPORT_EMAIL = 'ivanjohnsonijj@gmail.com';

function trimEnv(value) {
  return String(value ?? '').trim();
}

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
const support = {
  whatsapp: trimEnv(process.env.VITE_SUPPORT_WHATSAPP),
  phone: trimEnv(process.env.VITE_SUPPORT_PHONE),
  phoneDisplay: trimEnv(process.env.VITE_SUPPORT_PHONE_DISPLAY),
  email:
    trimEnv(process.env.VITE_SUPPORT_EMAIL) ||
    trimEnv(process.env.SUPPORT_EMAIL) ||
    DEFAULT_SUPPORT_EMAIL,
};

const body = [
  `window.__KASIPAY_API_URL__=${JSON.stringify(apiUrl)};`,
  `window.__KASIPAY_SUPPORT__=${JSON.stringify(support)};`,
  '',
].join('\n');

fs.writeFileSync(out, body, 'utf8');
console.info(`[runtime-config] ${apiUrl} support=${support.email || '(none)'}`);
