import { randomUUID } from 'node:crypto';

import { Router } from 'express';

import { getPgPool } from '../dbPg.js';
import { signToken } from '../jwt.js';
import { toPublicUser } from '../mappers.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { hashPin, verifyPin } from '../password.js';
import { currencyForPool, DEFAULT_POOL_ID } from '../poolConstants.js';
import {
  clearPinFailuresPg,
  ensureNotLockedPg,
  recordPinFailurePg,
} from '../security/pinAttemptsPg.js';
import {
  createAuthSessionPg,
  findSessionByRefreshPg,
  maybeHandleRefreshReusePg,
  revokeSessionPg,
  rotateRefreshTokenForSessionPg,
} from '../sessionAuthPg.js';
import type { RowUser } from '../types.js';
import {
  loginBodySchema,
  refreshBodySchema,
  registerBodySchema,
} from '../validation.js';

export const authRouterPg = Router();

async function issueSessionTokensPg(
  user: RowUser,
): Promise<{ token: string; refreshToken: string }> {
  const pool = getPgPool();
  const { sessionId, refreshRaw } = await createAuthSessionPg(pool, user.id);
  const token = signToken({
    sub: user.id,
    phone: user.phone,
    role: user.role,
    sid: sessionId,
  });
  return { token, refreshToken: refreshRaw };
}

authRouterPg.post('/register', async (req, res) => {
  const parsed = registerBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const body = parsed.data;
  const pool = getPgPool();
  const now = new Date().toISOString();
  const userId = randomUUID();
  const walletId = randomUUID();
  const pinHash = hashPin(body.pin);
  const kyc = 'pending';
  const tier = 'Basic';

  const countryCode = body.countryCode ?? DEFAULT_POOL_ID;
  const poolId = countryCode;
  const walletCurrency = currencyForPool(poolId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO users (
        id, name, phone, pin_hash, role, kyc_status, account_tier, created_at,
        country_code, is_system
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0)`,
      [
        userId,
        body.name,
        body.phone,
        pinHash,
        body.role,
        kyc,
        tier,
        now,
        countryCode,
      ],
    );

    await client.query(
      `INSERT INTO wallets (
        id, user_id, balance, currency, status, pool_id, wallet_kind
      ) VALUES ($1, $2, 0, $3, 'active', $4, 'user')`,
      [walletId, userId, walletCurrency, poolId],
    );

    if (body.role === 'merchant') {
      const businessName =
        body.businessName?.trim() || `${body.name.trim()}'s Shop`;
      const location = body.location?.trim() || 'South Africa';
      const category = body.category?.trim() || 'Retail';
      const merchantId = randomUUID();
      await client.query(
        `INSERT INTO merchants (
           id, user_id, business_name, location, category, approval_status
         ) VALUES ($1, $2, $3, $4, $5, 'pending_docs')`,
        [merchantId, userId, businessName, location, category],
      );
    }

    await client.query('COMMIT');
  } catch (e: unknown) {
    await client.query('ROLLBACK');
    const err = e as { code?: string };
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Phone already registered' });
    }
    throw e;
  } finally {
    client.release();
  }

  const userQ = await pool.query<RowUser>(
    `SELECT * FROM users WHERE id = $1`,
    [userId],
  );
  const user = userQ.rows[0];
  if (!user) {
    return res.status(500).json({ error: 'Could not load created user' });
  }

  const { token, refreshToken } = await issueSessionTokensPg(user);
  return res.status(201).json({ token, refreshToken, user: toPublicUser(user) });
});

authRouterPg.post('/login', async (req, res) => {
  const parsed = loginBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { phone, pin } = parsed.data;
  const pool = getPgPool();

  const userQ = await pool.query<RowUser>(
    `SELECT * FROM users WHERE phone = $1`,
    [phone],
  );
  const user = userQ.rows[0];
  if (!user || user.is_system === 1 || user.deleted_at || user.suspended_at) {
    return res.status(401).json({ error: 'Invalid phone or PIN' });
  }

  try {
    await ensureNotLockedPg(pool, user.id);
  } catch (e) {
    const err = e as { status?: number; message?: string };
    return res
      .status(err.status ?? 423)
      .json({ error: err.message ?? 'Account temporarily locked' });
  }

  if (!verifyPin(pin, user.pin_hash)) {
    await recordPinFailurePg(pool, user.id);
    return res.status(401).json({ error: 'Invalid phone or PIN' });
  }

  await clearPinFailuresPg(pool, user.id);
  const { token, refreshToken } = await issueSessionTokensPg(user);
  return res.json({ token, refreshToken, user: toPublicUser(user) });
});

authRouterPg.post('/refresh', async (req, res) => {
  const parsed = refreshBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid refresh payload' });
  }
  const pool = getPgPool();
  const hit = await findSessionByRefreshPg(pool, parsed.data.refreshToken);
  if (!hit) {
    const reuse = await maybeHandleRefreshReusePg(pool, parsed.data.refreshToken);
    if (reuse.reused) {
      return res.status(401).json({
        error:
          'Refresh token reuse detected — all sessions revoked. Please sign in again.',
      });
    }
    return res
      .status(401)
      .json({ error: 'Invalid or expired refresh session' });
  }

  try {
    const newRefreshPlain = await rotateRefreshTokenForSessionPg(pool, hit.id);
    const userQ = await pool.query<RowUser>(
      `SELECT * FROM users WHERE id = $1`,
      [hit.user_id],
    );
    const user = userQ.rows[0];
    if (!user || user.is_system === 1 || user.deleted_at || user.suspended_at) {
      await revokeSessionPg(pool, hit.id);
      return res.status(401).json({ error: 'User not found' });
    }
    const token = signToken({
      sub: user.id,
      phone: user.phone,
      role: user.role,
      sid: hit.id,
    });
    return res.json({
      token,
      refreshToken: newRefreshPlain,
    });
  } catch {
    return res.status(401).json({ error: 'Could not extend session' });
  }
});

authRouterPg.post('/logout', requireAuth, async (req, res) => {
  const pool = getPgPool();
  await revokeSessionPg(pool, req.auth!.sessionId);
  return res.json({ ok: true });
});
