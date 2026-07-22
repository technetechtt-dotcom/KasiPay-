import { createHash, randomInt, randomUUID } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import { NODE_ENV, PIN_RESET_PEPPER } from '../config.js';
import { getDb } from '../db.js';
import { sendSms } from '../services/sms.js';
import { toPublicUser } from '../mappers.js';
import { getRuntimeProductControls } from '../middleware/productionControls.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { hashPin, verifyPin } from '../password.js';
import { clearPinFailures } from '../security/pinAttempts.js';
import { revokeAllUserSessions } from '../sessionAuth.js';
import type { RowUser } from '../types.js';
import { accountPin, updatePinBodySchema } from '../validation.js';

export const meRouter = Router();

meRouter.get('/runtime-controls', requireAuth, (_req, res) => {
  return res.json({ controls: getRuntimeProductControls() });
});

meRouter.get('/me', requireAuth, (req, res) => {
  const database = getDb();
  const user = database
    .prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL')
    .get(req.auth!.userId) as RowUser | undefined;
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  return res.json({ user: toPublicUser(user) });
});

meRouter.patch('/me/pin', requireAuth, (req, res) => {
  const parsed = updatePinBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { currentPin, newPin } = parsed.data;
  if (currentPin === newPin) {
    return res.status(400).json({ error: 'New PIN must differ from current PIN' });
  }
  const database = getDb();
  const user = database
    .prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL')
    .get(req.auth!.userId) as RowUser | undefined;
  if (!user || !verifyPin(currentPin, user.pin_hash)) {
    return res.status(401).json({ error: 'Current PIN is incorrect' });
  }
  const nextHash = hashPin(newPin);
  database.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(nextHash, user.id);
  // Force other devices / lingering refresh tokens to sign back in.
  revokeAllUserSessions(database, user.id);
  return res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Forgot-PIN flow                                                    */
/* ------------------------------------------------------------------ */

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

/**
 * Issue a one-time 6-digit PIN-reset code for the phone, if it matches a real
 * account. Always returns 200 with `{ ok: true }` regardless of whether the
 * phone existed (to avoid enumeration). In non-production environments the
 * code is also returned in the body / printed to the server console so testing
 * works without an SMS provider configured. In production, plug an SMS sender
 * in at the marked spot.
 */
meRouter.post('/pin-reset/request', async (req, res) => {
  const parsed = pinResetRequest.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const database = getDb();
  const user = database
    .prepare(
      `SELECT id, phone FROM users
       WHERE phone = ? AND is_system = 0 AND deleted_at IS NULL`,
    )
    .get(parsed.data.phone) as { id: string; phone: string } | undefined;

  // Generic success response so callers can't probe which phones exist.
  const generic = {
    ok: true,
    message:
      'If that phone is registered, a 6-digit reset code has been sent.',
  };

  if (!user) return res.json(generic);

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const now = Date.now();
  // Burn previous unused codes for this user — keep only the latest.
  database
    .prepare(`DELETE FROM pin_reset_codes WHERE user_id = ?`)
    .run(user.id);
  database
    .prepare(
      `INSERT INTO pin_reset_codes (id, user_id, code_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      user.id,
      hashResetCode(user.id, code),
      new Date(now + PIN_RESET_TTL_MS).toISOString(),
      new Date(now).toISOString(),
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
    console.info(`[pin-reset] code sent for ${user.phone} (devCode echoed in response)`);
    return res.json({ ...generic, devCode: code });
  }
  return res.json(generic);
});

meRouter.post('/pin-reset/confirm', (req, res) => {
  const parsed = pinResetConfirm.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const database = getDb();
  const user = database
    .prepare(
      `SELECT id FROM users
       WHERE phone = ? AND is_system = 0 AND deleted_at IS NULL`,
    )
    .get(parsed.data.phone) as { id: string } | undefined;
  if (!user) {
    return res
      .status(401)
      .json({ error: 'Reset code is invalid or expired.' });
  }

  const row = database
    .prepare(
      `SELECT id, code_hash, expires_at, used_at FROM pin_reset_codes
       WHERE user_id = ? ORDER BY datetime(created_at) DESC LIMIT 1`,
    )
    .get(user.id) as
    | {
        id: string;
        code_hash: string;
        expires_at: string;
        used_at: string | null;
      }
    | undefined;
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
  database.transaction(() => {
    database
      .prepare('UPDATE users SET pin_hash = ? WHERE id = ?')
      .run(nextHash, user.id);
    database
      .prepare(
        `UPDATE pin_reset_codes SET used_at = ? WHERE id = ?`,
      )
      .run(new Date().toISOString(), row.id);
    clearPinFailures(database, user.id);
    revokeAllUserSessions(database, user.id);
  })();
  return res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Account deletion (POPIA / right-to-erase)                           */
/* ------------------------------------------------------------------ */

const accountDeleteBody = z.object({
  pin: z.string().min(4).max(12),
  confirmPhrase: z
    .string()
    .min(1)
    .refine((v) => v.trim().toUpperCase() === 'DELETE MY ACCOUNT', {
      message: 'Type DELETE MY ACCOUNT to confirm.',
    }),
});

/**
 * Soft-delete the authenticated user: marks `deleted_at`, suspends the wallet,
 * scrubs identifying fields, and revokes all sessions. Ledger / sales rows are
 * intentionally retained for audit + tax law compliance (referenced by id).
 * A hard purge is out of scope for the API and would happen via a back-office
 * job after the statutory retention window.
 */
meRouter.delete('/me', requireAuth, (req, res) => {
  const parsed = accountDeleteBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const database = getDb();
  const user = database
    .prepare(
      `SELECT * FROM users WHERE id = ? AND is_system = 0 AND deleted_at IS NULL`,
    )
    .get(req.auth!.userId) as RowUser | undefined;
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!verifyPin(parsed.data.pin, user.pin_hash)) {
    return res.status(401).json({ error: 'PIN is incorrect.' });
  }

  const walletBalance = (
    database
      .prepare(
        `SELECT balance FROM wallets WHERE user_id = ?`,
      )
      .get(user.id) as { balance: number } | undefined
  )?.balance ?? 0;
  if (walletBalance > 0.01) {
    return res.status(409).json({
      error: `Wallet still has R${walletBalance.toFixed(2)}. Withdraw or transfer it before closing the account.`,
    });
  }

  database.transaction(() => {
    database
      .prepare(
        `UPDATE users
            SET deleted_at = ?,
                name = 'Closed Account',
                phone = 'deleted:' || id
          WHERE id = ?`,
      )
      .run(new Date().toISOString(), user.id);
    database
      .prepare(
        `UPDATE wallets SET status = 'closed' WHERE user_id = ?`,
      )
      .run(user.id);
    revokeAllUserSessions(database, user.id);
    clearPinFailures(database, user.id);
  })();
  return res.json({ ok: true });
});
