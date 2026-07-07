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

    await pool.query(
      `INSERT INTO users (id, name, phone, pin_hash, role, kyc_status, account_tier, created_at)
       VALUES ($1, $2, $3, $4, 'agent', 'verified', 'Basic', $5),
              ($6, $7, $8, $4, 'agent', 'verified', 'Basic', $5)`,
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
      `INSERT INTO wallets (id, user_id, balance, currency, status, pool_id, wallet_kind)
       VALUES ($1, $2, 1000, 'ZAR', 'active', 'ZA', 'user'),
              ($3, $4, 0, 'ZAR', 'active', 'ZA', 'user')`,
      [senderWalletId, senderId, collectorWalletId, collectorId],
    );

    const senderSession = await createAuthSessionPg(pool, senderId);
    const collectorSession = await createAuthSessionPg(pool, collectorId);
    senderToken = signToken({
      sub: senderId,
      phone: senderPhone,
      role: 'agent',
      sid: senderSession.sessionId,
    });
    collectorToken = signToken({
      sub: collectorId,
      phone: collectorPhone,
      role: 'agent',
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
      senderPhone,
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
      senderPhone,
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
      senderPhone,
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

  it('collects a voucher with matching PIN and SA ID', async () => {
    assert.ok(voucherRefForCollect);
    const res = await httpJson(baseUrl, 'POST', '/cash-send/collect', collectorToken, {
      referenceNumber: voucherRefForCollect,
      pin: voucherPin,
      scannedIdDocument: recipientSaId,
    });
    assert.ok(res.status >= 200 && res.status < 300);
    const body = res.json as { voucher?: { status?: string } };
    assert.equal(body.voucher?.status, 'collected');
  });
});
