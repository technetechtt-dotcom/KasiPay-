import { createHmac, randomInt, randomUUID } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import { NODE_ENV, PIN_RESET_PEPPER } from '../config.js';
import { getPgPool } from '../dbPg.js';
import { toPublicUser } from '../mappers.js';
import { formatCents, parseIntegerCents } from '../money.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { hashPin, verifyPin } from '../password.js';
import { clearPinFailuresPg } from '../security/pinAttemptsPg.js';
import { sendSms } from '../services/sms.js';
import { revokeAllUserSessionsPg } from '../sessionAuthPg.js';
import type { RowUser } from '../types.js';
import { accountPin, updatePinBodySchema } from '../validation.js';
import { getRuntimeProductControls } from '../middleware/productionControls.js';

export const meRouterPg = Router();

meRouterPg.get('/runtime-controls', requireAuth, (_req, res) => {
  return res.json({ controls: getRuntimeProductControls() });
});

meRouterPg.get('/me', requireAuth, async (req, res) => {
  const pool = getPgPool();
  const q = await pool.query<RowUser>(
    `SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [req.auth!.userId],
  );
  const user = q.rows[0];
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  return res.json({ user: toPublicUser(user) });
});

meRouterPg.patch('/me/pin', requireAuth, async (req, res) => {
  const parsed = updatePinBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { currentPin, newPin } = parsed.data;
  if (currentPin === newPin) {
    return res
      .status(400)
      .json({ error: 'New PIN must differ from current PIN' });
  }
  const pool = getPgPool();
  const userQ = await pool.query<RowUser>(
    `SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [req.auth!.userId],
  );
  const user = userQ.rows[0];
  if (!user || !verifyPin(currentPin, user.pin_hash)) {
    return res.status(401).json({ error: 'Current PIN is incorrect' });
  }
  const nextHash = hashPin(newPin);
  await pool.query(`UPDATE users SET pin_hash = $1, token_version = token_version + 1 WHERE id = $2`, [
    nextHash,
    user.id,
  ]);
  await revokeAllUserSessionsPg(pool, user.id);
  return res.json({ ok: true });
});

const PIN_RESET_TTL_MS = 10 * 60_000;

function hashResetCode(userId: string, code: string): string {
  return createHmac('sha256', PIN_RESET_PEPPER)
    .update(`${userId}:${code}`)
    .digest('hex');
}

const phoneOnly = z
  .string()
  .min(9)
  .max(20)
  .transform((v) => v.replace(/\D/g, ''));

const pinResetRequest = z.object({ phone: phoneOnly });
const pinResetConfirm = z.object({
  phone: phoneOnly,
  code: z
    .string()
    .regex(/^\d{6}$/u, 'Code must be 6 digits')
    .transform((v) => v.trim()),
  newPin: accountPin,
});

meRouterPg.post('/pin-reset/request', async (req, res) => {
  const parsed = pinResetRequest.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const pool = getPgPool();
  const userQ = await pool.query<{ id: string; phone: string }>(
    `SELECT id, phone FROM users
     WHERE phone = $1 AND is_system = 0 AND deleted_at IS NULL`,
    [parsed.data.phone],
  );
  const user = userQ.rows[0];

  const generic = {
    ok: true,
    message:
      'If that phone is registered, a 6-digit reset code has been sent.',
  };

  if (!user) return res.json(generic);

  const limits = await pool.query<{ daily_count: string; recent_count: string }>(
    `SELECT
       count(*) FILTER (WHERE created_at > NOW() - interval '24 hours')::text AS daily_count,
       count(*) FILTER (WHERE created_at > NOW() - interval '60 seconds')::text AS recent_count
       FROM pin_reset_codes WHERE user_id = $1`,
    [user.id],
  );
  if (
    Number(limits.rows[0]?.daily_count ?? 0) >= 5 ||
    Number(limits.rows[0]?.recent_count ?? 0) >= 1
  ) {
    return res.json(generic);
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const now = Date.now();
  await pool.query(
    `UPDATE pin_reset_codes SET used_at = COALESCE(used_at, NOW())
      WHERE user_id = $1 AND used_at IS NULL`,
    [user.id],
  );
  await pool.query(
    `INSERT INTO pin_reset_codes (id, user_id, code_hash, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      randomUUID(),
      user.id,
      hashResetCode(user.id, code),
      new Date(now + PIN_RESET_TTL_MS).toISOString(),
      new Date(now).toISOString(),
    ],
  );
  await pool.query(
    `INSERT INTO security_notifications_outbox
      (id, user_id, channel, template, destination_hash, payload)
     VALUES ($1,$2,'sms','pin_recovery_requested',$3,'{}'::jsonb)`,
    [
      randomUUID(),
      user.id,
      createHmac('sha256', PIN_RESET_PEPPER).update(user.phone).digest('hex'),
    ],
  );

  const smsBody = `Ekasi Pay PIN reset code: ${code}. Valid for 10 minutes. Do not share this code.`;

  try {
    await sendSms(user.phone, smsBody);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'SMS delivery failed';
    console.error(`[pin-reset] SMS delivery failed: ${msg}`);
    if (NODE_ENV === 'production') return res.json(generic);
    return res.json({ ...generic, devCode: code });
  }

  if (NODE_ENV !== 'production') {
    return res.json({ ...generic, devCode: code });
  }
  return res.json(generic);
});

meRouterPg.post('/pin-reset/confirm', async (req, res) => {
  const parsed = pinResetConfirm.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const pool = getPgPool();
  const userQ = await pool.query<{ id: string }>(
    `SELECT id FROM users
     WHERE phone = $1 AND is_system = 0 AND deleted_at IS NULL`,
    [parsed.data.phone],
  );
  const user = userQ.rows[0];
  if (!user) {
    return res
      .status(401)
      .json({ error: 'Reset code is invalid or expired.' });
  }

  const rowQ = await pool.query<{
    id: string;
    code_hash: string;
    expires_at: string;
    used_at: string | null;
    attempts: number;
  }>(
    `SELECT id, code_hash, expires_at, used_at, attempts FROM pin_reset_codes
     WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [user.id],
  );
  const row = rowQ.rows[0];
  if (
    !row ||
    row.used_at ||
    row.attempts >= 5 ||
    new Date(row.expires_at).getTime() < Date.now() ||
    row.code_hash !== hashResetCode(user.id, parsed.data.code)
  ) {
    if (row && !row.used_at) {
      await pool.query(
        `UPDATE pin_reset_codes
            SET attempts = attempts + 1,
                used_at = CASE WHEN attempts + 1 >= 5 THEN NOW() ELSE used_at END
          WHERE id = $1 AND used_at IS NULL`,
        [row.id],
      );
    }
    return res
      .status(401)
      .json({ error: 'Reset code is invalid or expired.' });
  }

  const nextHash = hashPin(parsed.data.newPin);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const consumed = await client.query(
      `UPDATE pin_reset_codes SET used_at = NOW()
        WHERE id = $1 AND used_at IS NULL AND expires_at > NOW()
          AND code_hash = $2 AND attempts < 5`,
      [row.id, hashResetCode(user.id, parsed.data.code)],
    );
    if (!consumed.rowCount) throw Object.assign(new Error('Reset code is invalid or expired.'), { status: 401 });
    await client.query(`UPDATE users
      SET pin_hash = $1, token_version = token_version + 1 WHERE id = $2`, [
      nextHash, user.id,
    ]);
    await clearPinFailuresPg(client, user.id);
    await client.query(
      `UPDATE auth_sessions SET revoked_at = NOW(), revoke_reason = 'pin_recovery'
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [user.id],
    );
    await client.query(
      `INSERT INTO customer_security_context (user_id, last_recovery_at, recovery_hold_until)
       VALUES ($1,NOW(),NOW() + interval '24 hours')
       ON CONFLICT (user_id) DO UPDATE SET
         last_recovery_at=NOW(), recovery_hold_until=NOW() + interval '24 hours'`,
      [user.id],
    );
    await client.query(
      `INSERT INTO security_notifications_outbox
        (id, user_id, channel, template, payload)
       VALUES ($1,$2,'sms','pin_recovery_completed','{}'::jsonb)`,
      [randomUUID(), user.id],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return res.json({ ok: true });
});

const accountDeleteBody = z.object({
  pin: z.string().min(4).max(12),
  confirmPhrase: z
    .string()
    .min(1)
    .refine((v) => v.trim().toUpperCase() === 'DELETE MY ACCOUNT', {
      message: 'Type DELETE MY ACCOUNT to confirm.',
    }),
});

meRouterPg.delete('/me', requireAuth, async (req, res) => {
  const parsed = accountDeleteBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const pool = getPgPool();
  const userQ = await pool.query<RowUser>(
    `SELECT * FROM users
     WHERE id = $1 AND is_system = 0 AND deleted_at IS NULL`,
    [req.auth!.userId],
  );
  const user = userQ.rows[0];
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!verifyPin(parsed.data.pin, user.pin_hash)) {
    return res.status(401).json({ error: 'PIN is incorrect.' });
  }

  const walletQ = await pool.query<{ balance_cents: string }>(
    `SELECT balance_cents FROM wallets WHERE user_id = $1`,
    [user.id],
  );
  const walletBalance = parseIntegerCents(
    walletQ.rows[0]?.balance_cents ?? '0',
    { allowZero: true },
  );
  if (walletBalance > 0n) {
    return res.status(409).json({
      error: `Wallet still has R${formatCents(walletBalance)}. Withdraw or transfer it before closing the account.`,
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE users
          SET deleted_at = $1,
              name = 'Closed Account',
              phone = 'deleted:' || id
        WHERE id = $2`,
      [new Date().toISOString(), user.id],
    );
    await client.query(
      `UPDATE wallets SET status = 'closed' WHERE user_id = $1`,
      [user.id],
    );
    await revokeAllUserSessionsPg(pool, user.id);
    await clearPinFailuresPg(client, user.id);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return res.json({ ok: true });
});
