import { createHash, randomInt, randomUUID } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import { NODE_ENV, PIN_RESET_PEPPER } from '../config.js';
import { getPgPool } from '../dbPg.js';
import { toPublicUser } from '../mappers.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { hashPin, verifyPin } from '../password.js';
import { clearPinFailuresPg } from '../security/pinAttemptsPg.js';
import { sendSms } from '../services/sms.js';
import { revokeAllUserSessionsPg } from '../sessionAuthPg.js';
import type { RowUser } from '../types.js';
import { accountPin, updatePinBodySchema } from '../validation.js';

export const meRouterPg = Router();

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
  await pool.query(`UPDATE users SET pin_hash = $1 WHERE id = $2`, [
    nextHash,
    user.id,
  ]);
  await revokeAllUserSessionsPg(pool, user.id);
  return res.json({ ok: true });
});

const PIN_RESET_TTL_MS = 10 * 60_000;

function hashResetCode(userId: string, code: string): string {
  return createHash('sha256')
    .update(`${PIN_RESET_PEPPER}:${userId}:${code}`)
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

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const now = Date.now();
  await pool.query(`DELETE FROM pin_reset_codes WHERE user_id = $1`, [user.id]);
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

  const smsBody = `Ekasi Pay PIN reset code: ${code}. Valid for 10 minutes. Do not share this code.`;

  try {
    await sendSms(user.phone, smsBody);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'SMS delivery failed';
    console.error(`[pin-reset] SMS failed for ${user.phone}: ${msg}`);
    if (NODE_ENV === 'production') {
      return res.status(503).json({
        error: 'Could not send reset code right now. Try again shortly.',
      });
    }
    console.info(`[pin-reset] dev fallback code for ${user.phone} = ${code}`);
    return res.json({ ...generic, devCode: code });
  }

  if (NODE_ENV !== 'production') {
    console.info(
      `[pin-reset] code sent for ${user.phone} (devCode echoed in response)`,
    );
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
  }>(
    `SELECT id, code_hash, expires_at, used_at FROM pin_reset_codes
     WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [user.id],
  );
  const row = rowQ.rows[0];
  if (
    !row ||
    row.used_at ||
    new Date(row.expires_at).getTime() < Date.now() ||
    row.code_hash !== hashResetCode(user.id, parsed.data.code)
  ) {
    return res
      .status(401)
      .json({ error: 'Reset code is invalid or expired.' });
  }

  const nextHash = hashPin(parsed.data.newPin);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE users SET pin_hash = $1 WHERE id = $2`, [
      nextHash,
      user.id,
    ]);
    await client.query(`UPDATE pin_reset_codes SET used_at = $1 WHERE id = $2`, [
      new Date().toISOString(),
      row.id,
    ]);
    await clearPinFailuresPg(client, user.id);
    await revokeAllUserSessionsPg(pool, user.id);
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

  const walletQ = await pool.query<{ balance: number }>(
    `SELECT balance FROM wallets WHERE user_id = $1`,
    [user.id],
  );
  const walletBalance = walletQ.rows[0]?.balance ?? 0;
  if (walletBalance > 0.01) {
    return res.status(409).json({
      error: `Wallet still has R${walletBalance.toFixed(2)}. Withdraw or transfer it before closing the account.`,
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
