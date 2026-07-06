import { randomUUID } from 'node:crypto';

import { Router } from 'express';

import { getDb } from '../db.js';
import { signToken } from '../jwt.js';
import { toPublicUser } from '../mappers.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { hashPin, verifyPin } from '../password.js';
import { currencyForPool, DEFAULT_POOL_ID } from '../poolConstants.js';
import {
  clearPinFailures,
  ensureNotLocked,
  recordPinFailure,
} from '../security/pinAttempts.js';
import {
  createAuthSession,
  findSessionByRefresh,
  maybeHandleRefreshReuse,
  revokeSession,
  rotateRefreshTokenForSession,
} from '../sessionAuth.js';
import type { RowUser } from '../types.js';
import {
  loginBodySchema,
  refreshBodySchema,
  registerBodySchema,
} from '../validation.js';

export const authRouter = Router();

function issueSessionTokens(user: RowUser): {
  token: string;
  refreshToken: string;
} {
  const database = getDb();
  const { sessionId, refreshRaw } = createAuthSession(database, user.id);
  const token = signToken({
    sub: user.id,
    phone: user.phone,
    role: user.role,
    sid: sessionId,
  });
  return { token, refreshToken: refreshRaw };
}

authRouter.post('/register', (req, res) => {
  const parsed = registerBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const body = parsed.data;
  const database = getDb();
  const now = new Date().toISOString();
  const userId = randomUUID();
  const walletId = randomUUID();
  const pinHash = hashPin(body.pin);
  const kyc = 'pending';
  const tier = 'Basic';

  const countryCode = body.countryCode ?? DEFAULT_POOL_ID;
  const poolId = countryCode;
  const walletCurrency = currencyForPool(poolId);

  try {
    database.transaction(() => {
      database
        .prepare(
          `INSERT INTO users (
            id, name, phone, pin_hash, role, kyc_status, account_tier, created_at,
            country_code, is_system
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
        )
        .run(
          userId,
          body.name,
          body.phone,
          pinHash,
          body.role,
          kyc,
          tier,
          now,
          countryCode
        );

      database
        .prepare(
          `INSERT INTO wallets (
            id, user_id, balance, currency, status, pool_id, wallet_kind
           )
           VALUES (?, ?, 0, ?, 'active', ?, 'user')`
        )
        .run(walletId, userId, walletCurrency, poolId);

      if (body.role === 'merchant') {
        const businessName =
          body.businessName?.trim() || `${body.name.trim()}'s Shop`;
        const location = body.location?.trim() || 'South Africa';
        const category = body.category?.trim() || 'Retail';
        const merchantId = randomUUID();
        database
          .prepare(
            `INSERT INTO merchants (id, user_id, business_name, location, category)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(merchantId, userId, businessName, location, category);
      }
    })();

    const user = database
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(userId) as RowUser;

    const { token, refreshToken } = issueSessionTokens(user);

    return res
      .status(201)
      .json({ token, refreshToken, user: toPublicUser(user) });
  } catch (e: unknown) {
    const err = e as { code?: string };
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Phone already registered' });
    }
    throw e;
  }
});

authRouter.post('/login', (req, res) => {
  const parsed = loginBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { phone, pin } = parsed.data;
  const database = getDb();
  const user = database
    .prepare('SELECT * FROM users WHERE phone = ?')
    .get(phone) as RowUser | undefined;
  if (!user || user.is_system === 1 || user.deleted_at || user.suspended_at) {
    // Constant-time-ish: deny without revealing whether phone exists.
    return res.status(401).json({ error: 'Invalid phone or PIN' });
  }
  try {
    ensureNotLocked(database, user.id);
  } catch (e) {
    const err = e as { status?: number; message?: string };
    return res
      .status(err.status ?? 423)
      .json({ error: err.message ?? 'Account temporarily locked' });
  }
  if (!verifyPin(pin, user.pin_hash)) {
    recordPinFailure(database, user.id);
    return res.status(401).json({ error: 'Invalid phone or PIN' });
  }
  clearPinFailures(database, user.id);
  const { token, refreshToken } = issueSessionTokens(user);
  return res.json({
    token,
    refreshToken,
    user: toPublicUser(user),
  });
});

authRouter.post('/refresh', (req, res) => {
  const parsed = refreshBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid refresh payload' });
  }
  const database = getDb();
  const hit = findSessionByRefresh(database, parsed.data.refreshToken);
  if (!hit) {
    // The token didn't match a live session. If it matches *any* session row
    // (revoked / expired) that's a replay signal — burn the whole family.
    const reuse = maybeHandleRefreshReuse(database, parsed.data.refreshToken);
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
    const newRefreshPlain = rotateRefreshTokenForSession(database, hit.id);
    const user = database
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(hit.user_id) as RowUser | undefined;
    if (!user || user.is_system === 1 || user.deleted_at || user.suspended_at) {
      revokeSession(database, hit.id);
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

authRouter.post('/logout', requireAuth, (req, res) => {
  const database = getDb();
  revokeSession(database, req.auth!.sessionId);
  return res.json({ ok: true });
});
