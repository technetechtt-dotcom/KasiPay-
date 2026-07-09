/**
 * Uses a temp DB and SMOKE_PORT (default 18787) so this does not collide with a dev server.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const port = Number(process.env.SMOKE_PORT ?? 18787);
const smokeOrigin = process.env.SMOKE_ORIGIN ?? 'http://localhost:5173';
const dbFile = path.join(
  os.tmpdir(),
  `ekasi-pay-smoke-${process.pid}-${Date.now()}.db`
);
const base = `http://127.0.0.1:${port}`;

/** Non-trivial PIN that passes accountPin validation in smoke runs. */
const SMOKE_PIN = '59247';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function apiHeaders(extra = {}) {
  return { Origin: smokeOrigin, ...extra };
}

async function apiFetch(url, init = {}) {
  const headers = apiHeaders(init.headers ?? {});
  return fetch(url, { ...init, headers });
}

async function fetchHealth() {
  const res = await fetch(`${base}/health`);
  if (!res.ok) {
    throw new Error(`health HTTP ${res.status}`);
  }
  const body = await res.json();
  if (body?.ok !== true || body?.service !== 'ekasi-pay-api') {
    throw new Error(`unexpected health payload: ${JSON.stringify(body)}`);
  }
}

/**
 * Helper: register a new merchant, return token + refreshToken + userId.
 * Each caller gets a freshly generated phone so test runs never collide.
 */
async function registerMerchant(label = 'M') {
  const phone = `07${Date.now().toString().slice(-7)}${Math.floor(
    Math.random() * 90 + 10,
  )}`;
  const res = await apiFetch(`${base}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `Smoke ${label}`,
      phone,
      pin: SMOKE_PIN,
      role: 'merchant',
      businessName: `Shop ${label}`,
      location: 'Soweto',
      category: 'Retail',
    }),
  });
  const body = await res.json();
  if (!res.ok || !body.token || !body.refreshToken) {
    throw new Error(
      `register failed ${res.status}: ${JSON.stringify(body).slice(0, 200)}`,
    );
  }
  return {
    phone,
    token: body.token,
    refreshToken: body.refreshToken,
    userId: body.user.id,
  };
}

async function smokeAuthLifecycle() {
  const m = await registerMerchant('Auth');

  let res = await apiFetch(`${base}/api/me`, {
    headers: { Authorization: `Bearer ${m.token}` },
  });
  let body = await res.json();
  if (!res.ok || !body?.user?.id) {
    throw new Error(`me failed ${res.status}: ${JSON.stringify(body)}`);
  }

  res = await apiFetch(`${base}/api/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: m.refreshToken }),
  });
  body = await res.json();
  if (!res.ok || !body.token || !body.refreshToken) {
    throw new Error(`refresh failed ${res.status}: ${JSON.stringify(body)}`);
  }

  res = await apiFetch(`${base}/api/logout`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${body.token}`,
      'Content-Type': 'application/json',
    },
  });
  body = await res.json();
  if (!res.ok || body?.ok !== true) {
    throw new Error(`logout failed ${res.status}: ${JSON.stringify(body)}`);
  }
}

async function smokeSalesFlow() {
  const m = await registerMerchant('Sales');

  // Create a product (POST /api/products)
  let res = await apiFetch(`${base}/api/products`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${m.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'Smoke Bread',
      costPrice: 8,
      price: 15,
      stock: 50,
      category: 'Food',
    }),
  });
  let body = await res.json();
  if (!res.ok || !body?.product?.id) {
    throw new Error(`product create failed ${res.status}: ${JSON.stringify(body)}`);
  }
  const product = body.product;

  // Make a cash sale (POST /api/sales)
  res = await apiFetch(`${base}/api/sales`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${m.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      items: [
        {
          productId: product.id,
          name: product.name,
          quantity: 2,
          price: product.price,
          subtotal: product.price * 2,
        },
      ],
      total: product.price * 2,
      paymentMethod: 'cash',
    }),
  });
  body = await res.json();
  if (!res.ok || !body?.sale?.id) {
    throw new Error(`sale create failed ${res.status}: ${JSON.stringify(body)}`);
  }

  // List sales
  res = await apiFetch(`${base}/api/sales`, {
    headers: { Authorization: `Bearer ${m.token}` },
  });
  body = await res.json();
  if (!res.ok || !Array.isArray(body.sales) || body.sales.length < 1) {
    throw new Error(`sales list missing the new sale: ${JSON.stringify(body)}`);
  }

  // Income statement should reflect the sale
  res = await apiFetch(`${base}/api/reports/income-statement?period=daily`, {
    headers: { Authorization: `Bearer ${m.token}` },
  });
  body = await res.json();
  if (!res.ok || typeof body.totalRevenue !== 'number' || body.totalRevenue <= 0) {
    throw new Error(
      `income-statement missing revenue: ${JSON.stringify(body)}`,
    );
  }
}

async function smokeStockReports() {
  const m = await registerMerchant('Stock');

  let res = await apiFetch(`${base}/api/stock-intake`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${m.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      supplierName: 'Smoke Wholesale',
      slipReference: 'INV-001',
      slipTotal: 120,
      lines: [
        {
          name: 'Smoke Maize',
          quantity: 10,
          costPrice: 12,
          sellingPrice: 18,
          category: 'Food',
        },
      ],
    }),
  });
  let body = await res.json();
  if (!res.ok || !body?.slip?.id || !body?.products?.length) {
    throw new Error(`stock-intake failed ${res.status}: ${JSON.stringify(body)}`);
  }
  const product = body.products[0];

  res = await apiFetch(`${base}/api/reports/inventory`, {
    headers: { Authorization: `Bearer ${m.token}` },
  });
  body = await res.json();
  if (!res.ok || !Array.isArray(body.items) || body.items.length < 1) {
    throw new Error(`inventory report failed ${res.status}: ${JSON.stringify(body)}`);
  }

  res = await apiFetch(`${base}/api/reports/expense-statement?period=daily`, {
    headers: { Authorization: `Bearer ${m.token}` },
  });
  body = await res.json();
  if (!res.ok || typeof body.totalExpenses !== 'number' || body.totalExpenses < 120) {
    throw new Error(
      `expense-statement missing supplier purchase: ${JSON.stringify(body)}`,
    );
  }

  res = await apiFetch(`${base}/api/purchase-slips`, {
    headers: { Authorization: `Bearer ${m.token}` },
  });
  body = await res.json();
  if (!res.ok || !Array.isArray(body.slips) || body.slips.length < 1) {
    throw new Error(`purchase-slips list failed ${res.status}: ${JSON.stringify(body)}`);
  }

  // Sale should write stock movement out
  res = await apiFetch(`${base}/api/sales`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${m.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      items: [{ productId: product.id, quantity: 1, price: product.price }],
      paymentMethod: 'cash',
    }),
  });
  body = await res.json();
  if (!res.ok || !body?.sale?.id) {
    throw new Error(`stock sale failed ${res.status}: ${JSON.stringify(body)}`);
  }

  res = await apiFetch(`${base}/api/stock-movements`, {
    headers: { Authorization: `Bearer ${m.token}` },
  });
  body = await res.json();
  const hasSaleOut = body.movements?.some((mv) => mv.reason === 'sale');
  if (!res.ok || !hasSaleOut) {
    throw new Error(
      `stock-movements missing sale out: ${JSON.stringify(body).slice(0, 300)}`,
    );
  }
}

async function smokeCreditFlow() {
  const m = await registerMerchant('Credit');
  const saId = '8001015009087';
  const phone = '0820001234';

  let res = await apiFetch(`${base}/api/credit/verify/request`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${m.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ phone, purpose: 'onboard' }),
  });
  let body = await res.json();
  if (!res.ok) {
    throw new Error(`credit otp request failed ${res.status}: ${JSON.stringify(body)}`);
  }
  const onboardCode = body.devCode;
  if (!onboardCode) {
    throw new Error('credit otp request missing devCode in smoke environment');
  }

  res = await apiFetch(`${base}/api/credit/verify/confirm`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${m.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      phone,
      purpose: 'onboard',
      code: onboardCode,
      saIdDocument: saId,
    }),
  });
  body = await res.json();
  if (!res.ok || !body?.verificationToken) {
    throw new Error(`credit otp confirm failed ${res.status}: ${JSON.stringify(body)}`);
  }
  const onboardToken = body.verificationToken;

  res = await apiFetch(`${base}/api/credit/customers`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${m.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'Smoke Customer',
      phone,
      creditLimit: 500,
      saIdDocument: saId,
      verificationToken: onboardToken,
    }),
  });
  body = await res.json();
  if (!res.ok || !body?.customer?.id) {
    throw new Error(`credit customer failed ${res.status}: ${JSON.stringify(body)}`);
  }
  const customer = body.customer;

  res = await apiFetch(`${base}/api/credit/verify/request`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${m.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      phone,
      purpose: 'purchase',
      customerId: customer.id,
    }),
  });
  body = await res.json();
  if (!res.ok || !body?.devCode) {
    throw new Error(`credit purchase otp request failed ${res.status}: ${JSON.stringify(body)}`);
  }

  res = await apiFetch(`${base}/api/credit/verify/confirm`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${m.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      phone,
      purpose: 'purchase',
      customerId: customer.id,
      code: body.devCode,
      saIdDocument: saId,
    }),
  });
  body = await res.json();
  if (!res.ok || !body?.verificationToken) {
    throw new Error(`credit purchase otp confirm failed ${res.status}: ${JSON.stringify(body)}`);
  }

  res = await apiFetch(`${base}/api/credit/transactions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${m.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      customerId: customer.id,
      type: 'purchase',
      amount: 25,
      description: '1x Bread on credit',
      verificationToken: body.verificationToken,
    }),
  });
  body = await res.json();
  if (!res.ok || !body?.transaction?.id) {
    throw new Error(`credit txn failed ${res.status}: ${JSON.stringify(body)}`);
  }
}

async function smokePinRateLimit() {
  const m = await registerMerchant('Rate');
  // Trip the per-user lockout (5 wrong PINs in a row → 5 min lock).
  // We only need to confirm the response code escalates to 401/423 — we don't
  // want to spam the limiter for the rest of the suite.
  let lastStatus = 0;
  for (let i = 0; i < 6; i++) {
    const res = await apiFetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: m.phone, pin: '9999' }),
    });
    lastStatus = res.status;
    if (res.status === 423) break;
  }
  if (lastStatus !== 423 && lastStatus !== 429) {
    throw new Error(
      `PIN lockout did not engage — last status ${lastStatus} (expected 423/429)`,
    );
  }
}

const proc = spawn('node', ['dist/index.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    DATABASE_PATH: dbFile,
    DATABASE_URL: '',
    NODE_ENV: 'test',
    FRONTEND_ORIGIN: smokeOrigin,
    FRONTEND_ORIGINS: '',
  },
  stdio: 'inherit',
});

proc.on('error', (err) => {
  console.error(err);
});

let exitCode = 1;

try {
  let healthy = false;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (proc.exitCode !== null) {
      console.error(`smoke: server exited early (code ${proc.exitCode})`);
      exitCode = 1;
      healthy = false;
      break;
    }
    try {
      await fetchHealth();
      healthy = true;
      break;
    } catch {
      // retry until listener is up
    }
  }

  if (!healthy && proc.exitCode === null) {
    console.error(`smoke: ${base}/health never became OK`);
    exitCode = 1;
  } else if (healthy) {
    console.log(`smoke ok: GET ${base}/health`);
    const steps = [
      ['auth lifecycle (register → me → refresh → logout)', smokeAuthLifecycle],
      ['sales (product → sale → income statement)', smokeSalesFlow],
      ['stock intake + inventory + expense reports', smokeStockReports],
      ['credit book (customer → credit txn)', smokeCreditFlow],
      ['per-user PIN lockout', smokePinRateLimit],
    ];
    exitCode = 0;
    for (const [name, fn] of steps) {
      try {
        await fn();
        console.log(`smoke ok: ${name}`);
      } catch (e) {
        console.error(`smoke failed: ${name}:`, e);
        exitCode = 1;
        break;
      }
    }
  }
} finally {
  try {
    proc.kill();
  } catch {
    /* ignore */
  }
  await sleep(150);
  try {
    fs.unlinkSync(dbFile);
  } catch {
    /* temp file best-effort cleanup */
  }
}

process.exit(exitCode);
