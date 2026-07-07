import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(__dirname, '..', 'data', 'ekasi-pay.db');
const db = new Database(dbPath);

const vouchers = db
  .prepare(
    `SELECT id, reference_number, status, sender_phone, recipient_phone, amount, created_at
     FROM cash_send_vouchers ORDER BY created_at DESC`,
  )
  .all();
console.log('Vouchers in DB:', JSON.stringify(vouchers, null, 2));

const base = `http://localhost:${process.env.BACKEND_PORT || 8787}`;

async function tryLogin(phone, pin) {
  const r = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, pin }),
  });
  const j = await r.json().catch(() => ({}));
  return r.ok ? j.token : null;
}

const phones = ['0697040585', '0627539020', '0780000001'];
const pins = ['4321', '12345', '9999', '1927', '1234', '00000'];
let token = null;
for (const phone of phones) {
  for (const pin of pins) {
    token = await tryLogin(phone, pin);
    if (token) {
      console.log(`Logged in as ${phone} pin ${pin}`);
      break;
    }
  }
  if (token) break;
}

if (!token) {
  console.log('Could not login — skipping API tests');
  process.exit(0);
}

for (const v of vouchers) {
  const ref = v.reference_number;
  const r = await fetch(`${base}/api/cash-send/lookup`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ reference: ref, pin: '0000' }),
  });
  const j = await r.json().catch(() => ({}));
  console.log(`lookup ${ref} -> ${r.status}`, j);
}

const phone = '0697040585';
const phoneLookup = await fetch(`${base}/api/cash-send/lookup`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ reference: phone, pin: 'WRONG' }),
});
console.log('lookup phone wrong pin ->', phoneLookup.status, await phoneLookup.json().catch(() => ({})));
