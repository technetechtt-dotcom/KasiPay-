import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import express from 'express';

const RUN_PG =
  process.env.PG_INTEGRATION_TESTS === '1' &&
  Boolean(process.env.DATABASE_URL?.trim());

type JsonBody = Record<string, unknown>;

async function httpJson(
  baseUrl: string,
  method: string,
  path: string,
  token: string,
  body?: JsonBody,
): Promise<{ status: number; json: unknown }> {
  const payload = body ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          let json: unknown = null;
          if (raw) {
            try {
              json = JSON.parse(raw);
            } catch {
              json = raw;
            }
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('cashSendPg integration', { skip: !RUN_PG }, () => {
  const num = Date.now() % 10_000_000;
  const senderId = randomUUID();
  const collectorId = randomUUID();
  const senderPhone = `082${String(num).padStart(7, '0')}`.slice(0, 10);
  const collectorPhone = `083${String(num + 1).padStart(7, '0')}`.slice(0, 10);
  const recipientPhone = `084${String(num + 2).padStart(7, '0')}`.slice(0, 10);
  /** Walk-in customer cellphone (must differ from merchant account phone). */
  const customerSenderPhone = `085${String(num + 4).padStart(7, '0')}`.slice(0, 10);

  let baseUrl = '';
  let server: http.Server | null = null;
  let senderToken = '';
  let collectorToken = '';
  let voucherRefForLock = '';
  let voucherRefForCollect = '';
  const voucherPin = '1927';
  const senderSaId = '8001015009087';
  const recipientSaId = '5001015009080';

  before(async () => {
    const { initPg, getPgPool } = await import('./dbPg.js');
    const { hashPin } = await import('./password.js');
    const { createAuthSessionPg } = await import('./sessionAuthPg.js');
    const { signToken } = await import('./jwt.js');
    const { cashSendRouterPg } = await import('./routes/cashSendPg.js');
    const { requireAuth } = await import('./middleware/requireAuth.js');

    await initPg();
    const pool = getPgPool();
    const now = new Date().toISOString();
    const senderWalletId = randomUUID();
    const collectorWalletId = randomUUID();
    const senderMerchantId = randomUUID();
    const collectorMerchantId = randomUUID();
    const senderFloatId = randomUUID();
    const collectorFloatId = randomUUID();

    await pool.query(
      `INSERT INTO users (id, name, phone, pin_hash, role, kyc_status, account_tier, created_at)
       VALUES ($1, $2, $3, $4, 'merchant', 'verified', 'Basic', $5),
              ($6, $7, $8, $4, 'merchant', 'verified', 'Basic', $5)`,
      [
        senderId,
        'PG Test Sender',
        senderPhone,
        hashPin('9999'),
        now,
        collectorId,
        'PG Test Collector',
        collectorPhone,
      ],
    );
    await pool.query(
      `INSERT INTO merchants (id, user_id, business_name, location, category, approval_status)
       VALUES ($1,$2,'Sender Shop','ZA','spaza','approved'),
              ($3,$4,'Collector Shop','ZA','spaza','approved')`,
      [senderMerchantId, senderId, collectorMerchantId, collectorId],
    );
    await pool.query(
      `INSERT INTO merchant_activations (id, merchant_id, status)
       VALUES ($1,$2,'complete'), ($3,$4,'complete')`,
      [randomUUID(), senderId, randomUUID(), collectorId],
    );
    await pool.query(
      `INSERT INTO wallets (id, user_id, balance_cents, currency, status, pool_id, wallet_kind)
       VALUES ($1, $2, 0, 'ZAR', 'active', 'ZA', 'user'),
              ($3, $2, 100000, 'ZAR', 'active', 'ZA', 'merchant_float'),
              ($4, $5, 0, 'ZAR', 'active', 'ZA', 'user'),
              ($6, $5, 0, 'ZAR', 'active', 'ZA', 'merchant_float')`,
      [senderWalletId, senderId, senderFloatId, collectorWalletId, collectorId, collectorFloatId],
    );
    await pool.query(
      `INSERT INTO merchant_cash_availability (merchant_id, availability_band)
       VALUES ($1, 'over_5000')`,
      [collectorMerchantId],
    );
    await pool.query(
      `INSERT INTO payout_agents
         (merchant_id, status, float_floor_cents, per_transaction_limit_cents,
          daily_payout_limit_cents, enrolled_at)
       VALUES ($1, 'enrolled', 0, 500000, 200000, NOW())
       ON CONFLICT (merchant_id) DO UPDATE SET status = 'enrolled'`,
      [collectorId],
    );

    const senderSession = await createAuthSessionPg(pool, senderId);
    const collectorSession = await createAuthSessionPg(pool, collectorId);
    senderToken = signToken({
      sub: senderId,
      phone: senderPhone,
      role: 'merchant',
      sid: senderSession.sessionId,
    });
    collectorToken = signToken({
      sub: collectorId,
      phone: collectorPhone,
      role: 'merchant',
      sid: collectorSession.sessionId,
    });

    const app = express();
    app.use(express.json());
    app.use(requireAuth);
    app.use(cashSendRouterPg);

    server = app.listen(0);
    await new Promise<void>((resolve) => {
      server!.once('listening', resolve);
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('Failed to bind integration test server');
    }
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
    }
    const { getPgPool, closePg } = await import('./dbPg.js');
    const pool = getPgPool();
    await pool.query(
      `DELETE FROM cash_send_collect_failures
        WHERE reference_number IN (
          SELECT reference_number FROM cash_send_vouchers WHERE sender_user_id = $1
        )`,
      [senderId],
    );
    await pool.query(`DELETE FROM cash_send_vouchers WHERE sender_user_id = $1`, [
      senderId,
    ]);
    await pool.query(`DELETE FROM merchant_cash_availability WHERE merchant_id IN (
      SELECT id FROM merchants WHERE user_id = ANY($1::text[])
    )`, [[senderId, collectorId]]);
    await pool.query(`DELETE FROM merchant_activations WHERE merchant_id = ANY($1::text[])`, [
      [senderId, collectorId],
    ]);
    await pool.query(`DELETE FROM payout_agents WHERE merchant_id = ANY($1::text[])`, [
      [senderId, collectorId],
    ]);
    await pool.query(`DELETE FROM merchants WHERE user_id = ANY($1::text[])`, [
      [senderId, collectorId],
    ]);
    await pool.query(`DELETE FROM auth_sessions WHERE user_id = ANY($1::text[])`, [
      [senderId, collectorId],
    ]);
    await pool.query(`DELETE FROM wallets WHERE user_id = ANY($1::text[])`, [
      [senderId, collectorId],
    ]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [
      [senderId, collectorId],
    ]);
    await closePg();
  });

  it('rejects create when SA ID checksum is invalid', async () => {
    const res = await httpJson(baseUrl, 'POST', '/cash-send', senderToken, {
      senderFirstName: 'Test',
      senderLastName: 'Sender',
      senderIdDocument: '8001015009080',
      senderPhone: customerSenderPhone,
      senderAddress: '1 Test St, Johannesburg',
      recipientFirstName: 'Ben',
      recipientLastName: 'Eficiary',
      recipientPhone,
      recipientIdDocument: '',
      amount: 50,
      atmPin: voucherPin,
    });
    assert.equal(res.status, 400);
  });

  it('creates an active cash-send voucher', async () => {
    const res = await httpJson(baseUrl, 'POST', '/cash-send', senderToken, {
      senderFirstName: 'Test',
      senderLastName: 'Sender',
      senderIdDocument: senderSaId,
      senderPhone: customerSenderPhone,
      senderAddress: '1 Test St, Johannesburg',
      recipientFirstName: 'Ben',
      recipientLastName: 'Eficiary',
      recipientPhone,
      recipientIdDocument: '',
      amount: 50,
      atmPin: voucherPin,
    });
    assert.equal(res.status, 201);
    const body = res.json as { voucher?: { referenceNumber?: string; status?: string } };
    assert.equal(body.voucher?.status, 'active');
    assert.ok(body.voucher?.referenceNumber);
    voucherRefForCollect = body.voucher!.referenceNumber!;
  });

  it('creates a second voucher for collect PIN lockout', async () => {
    const res = await httpJson(baseUrl, 'POST', '/cash-send', senderToken, {
      senderFirstName: 'Test',
      senderLastName: 'Sender',
      senderIdDocument: senderSaId,
      senderPhone: customerSenderPhone,
      senderAddress: '1 Test St, Johannesburg',
      recipientFirstName: 'Ben',
      recipientLastName: 'Eficiary',
      recipientPhone: `081${String(num + 3).padStart(7, '0')}`.slice(0, 10),
      recipientIdDocument: '',
      amount: 25,
      atmPin: voucherPin,
    });
    assert.equal(res.status, 201);
    const body = res.json as { voucher?: { referenceNumber?: string } };
    voucherRefForLock = body.voucher!.referenceNumber!;
  });

  it('locks collect after repeated wrong PINs', async () => {
    assert.ok(voucherRefForLock);
    for (let i = 0; i < 5; i++) {
      const wrong = await httpJson(baseUrl, 'POST', '/cash-send/collect', collectorToken, {
        referenceNumber: voucherRefForLock,
        pin: '1111',
        scannedIdDocument: recipientSaId,
      });
      assert.equal(wrong.status, 401);
    }
    const locked = await httpJson(baseUrl, 'POST', '/cash-send/collect', collectorToken, {
      referenceNumber: voucherRefForLock,
      pin: '1111',
      scannedIdDocument: recipientSaId,
    });
    assert.equal(locked.status, 423);
  });

  it('allows only one concurrent collection and rejects replay', async () => {
    assert.ok(voucherRefForCollect);
    const collect = () => httpJson(baseUrl, 'POST', '/cash-send/collect', collectorToken, {
      referenceNumber: voucherRefForCollect,
      pin: voucherPin,
      scannedIdDocument: recipientSaId,
    });
    const concurrent = await Promise.all([collect(), collect()]);
    const statuses = concurrent.map((result) => result.status).sort();
    assert.equal(statuses.filter((status) => status >= 200 && status < 300).length, 1);
    assert.equal(statuses.filter((status) => status === 400 || status === 409).length, 1);
    const success = concurrent.find((result) => result.status >= 200 && result.status < 300)!;
    const body = success.json as { voucher?: { status?: string } };
    assert.equal(body.voucher?.status, 'collected');
    const replay = await collect();
    assert.equal(replay.status, 400);
  });
});
