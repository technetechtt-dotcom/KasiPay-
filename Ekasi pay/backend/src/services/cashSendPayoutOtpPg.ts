import { createHash, randomInt, randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { PIN_RESET_PEPPER } from '../config.js';
import { recordAuditEventPg } from './auditPg.js';
import { sendSms } from './sms.js';

type Db = Pool | PoolClient;

export const CASH_SEND_PAYOUT_OTP_TTL_MS = 10 * 60_000;
export const CASH_SEND_PAYOUT_OTP_COOLDOWN_MS = 60_000;
export const CASH_SEND_PAYOUT_OTP_MAX_SENDS = 5;
export const CASH_SEND_PAYOUT_OTP_MAX_FAILED = 5;
export const CASH_SEND_PAYOUT_OTP_LOCK_MS = 15 * 60_000;

function isPoolClient(database: Db): database is PoolClient {
  return typeof (database as PoolClient).release === 'function';
}

export function hashCashSendPayoutOtp(voucherId: string, phoneDigits: string, code: string): string {
  return createHash('sha256')
    .update(`${PIN_RESET_PEPPER}:cash-send-payout-otp:${voucherId}:${phoneDigits}:${code}`)
    .digest('hex');
}

export function hashCashSendPayoutPhone(phoneDigits: string): string {
  return createHash('sha256')
    .update(`${PIN_RESET_PEPPER}:cash-send-payout-phone:${phoneDigits}`)
    .digest('hex');
}

export function generateCashSendPayoutOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

async function recordOtpSecurityEvent(
  database: Db,
  input: {
    voucherId: string;
    outcome: string;
    actorUserId?: string;
    ipHash?: string;
    deviceHash?: string;
  },
): Promise<void> {
  await recordAuditEventPg(database, {
    type: 'cash_send.payout_otp',
    message: input.outcome,
    actorUserId: input.actorUserId ?? null,
    actorType: input.actorUserId ? 'user' : 'system',
    targetType: 'cash_send_voucher',
    targetId: input.voucherId,
    safeMetadata: { outcome: input.outcome },
    ipHash: input.ipHash,
    deviceHash: input.deviceHash,
  });
}

async function issueCashSendPayoutOtpLocked(
  client: PoolClient,
  input: {
    voucherId: string;
    recipientPhone: string;
    referenceNumber?: string;
    actorUserId?: string;
    ipHash?: string;
    deviceHash?: string;
  },
): Promise<{ expiresAt: string; sent: boolean }> {
  const phoneDigits = input.recipientPhone.replace(/\D/g, '');
  if (!phoneDigits) {
    throw Object.assign(new Error('Recipient phone is missing'), { status: 400 });
  }
  const voucher = await client.query<{ id: string; status: string }>(
    `SELECT id, status FROM cash_send_vouchers WHERE id = $1 FOR UPDATE`,
    [input.voucherId],
  );
  if (!voucher.rows[0] || voucher.rows[0].status !== 'active') {
    throw Object.assign(new Error('Voucher is not active'), { status: 400 });
  }

  const stats = await client.query<{ sends: string; last_sent_at: string | null }>(
    `SELECT count(*)::text AS sends, max(last_sent_at)::text AS last_sent_at
       FROM cash_send_payout_otps WHERE voucher_id = $1`,
    [input.voucherId],
  );
  const sends = Number(stats.rows[0]?.sends ?? 0);
  if (sends >= CASH_SEND_PAYOUT_OTP_MAX_SENDS) {
    await recordOtpSecurityEvent(client, {
      voucherId: input.voucherId,
      outcome: 'max_sends_exceeded',
      actorUserId: input.actorUserId,
      ipHash: input.ipHash,
      deviceHash: input.deviceHash,
    });
    throw Object.assign(new Error('Maximum payout OTP sends reached for this voucher'), {
      status: 429,
      code: 'PAYOUT_OTP_MAX_SENDS',
    });
  }
  const lastSent = stats.rows[0]?.last_sent_at ? Date.parse(stats.rows[0].last_sent_at) : 0;
  if (lastSent && Date.now() - lastSent < CASH_SEND_PAYOUT_OTP_COOLDOWN_MS) {
    await recordOtpSecurityEvent(client, {
      voucherId: input.voucherId,
      outcome: 'cooldown',
      actorUserId: input.actorUserId,
      ipHash: input.ipHash,
      deviceHash: input.deviceHash,
    });
    throw Object.assign(new Error('Wait 60 seconds before requesting another payout OTP'), {
      status: 429,
      code: 'PAYOUT_OTP_COOLDOWN',
    });
  }

  const active = await client.query<{ id: string; locked_until: string | null }>(
    `SELECT id, locked_until FROM cash_send_payout_otps
      WHERE voucher_id = $1 AND consumed_at IS NULL
      FOR UPDATE`,
    [input.voucherId],
  );
  if (active.rows[0]?.locked_until && Date.parse(active.rows[0].locked_until) > Date.now()) {
    await recordOtpSecurityEvent(client, {
      voucherId: input.voucherId,
      outcome: 'locked',
      actorUserId: input.actorUserId,
      ipHash: input.ipHash,
      deviceHash: input.deviceHash,
    });
    throw Object.assign(new Error('Payout for this voucher is temporarily locked after failed OTP attempts'), {
      status: 423,
      code: 'PAYOUT_OTP_LOCKED',
    });
  }
  if (active.rows[0]) {
    await client.query(
      `UPDATE cash_send_payout_otps
          SET consumed_at = clock_timestamp()
        WHERE id = $1 AND consumed_at IS NULL`,
      [active.rows[0].id],
    );
  }

  const code = generateCashSendPayoutOtpCode();
  const expiresAt = new Date(Date.now() + CASH_SEND_PAYOUT_OTP_TTL_MS).toISOString();
  try {
    await client.query(
      `INSERT INTO cash_send_payout_otps
         (id, voucher_id, phone_hash, code_hash, expires_at, failed_attempts, send_count, last_sent_at)
       VALUES ($1,$2,$3,$4,$5,0,$6,clock_timestamp())`,
      [
        randomUUID(),
        input.voucherId,
        hashCashSendPayoutPhone(phoneDigits),
        hashCashSendPayoutOtp(input.voucherId, phoneDigits, code),
        expiresAt,
        sends + 1,
      ],
    );
  } catch (error) {
    const codeName = (error as { code?: string }).code;
    if (codeName === '23505') {
      throw Object.assign(new Error('Another payout shop is issuing an OTP for this voucher. Retry once.'), {
        status: 409,
        code: 'PAYOUT_OTP_IN_FLIGHT',
      });
    }
    throw error;
  }

  await recordOtpSecurityEvent(client, {
    voucherId: input.voucherId,
    outcome: 'issued',
    actorUserId: input.actorUserId,
    ipHash: input.ipHash,
    deviceHash: input.deviceHash,
  });

  const hint = input.referenceNumber ? ` Voucher ${input.referenceNumber}.` : '';
  await sendSms(
    phoneDigits,
    `KasiPay cash collect code: ${code}. Expires in 10 minutes.${hint} Do not share it.`,
  );
  return { expiresAt, sent: true };
}

export async function issueCashSendPayoutOtpPg(
  database: Db,
  input: {
    voucherId: string;
    recipientPhone: string;
    referenceNumber?: string;
    actorUserId?: string;
    ipHash?: string;
    deviceHash?: string;
  },
): Promise<{ expiresAt: string; sent: boolean }> {
  if (isPoolClient(database)) {
    return issueCashSendPayoutOtpLocked(database, input);
  }
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    const issued = await issueCashSendPayoutOtpLocked(client, input);
    await client.query('COMMIT');
    return issued;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function consumeCashSendPayoutOtpPg(
  client: PoolClient,
  input: {
    voucherId: string;
    recipientPhone: string;
    code: string;
    actorUserId?: string;
    ipHash?: string;
    deviceHash?: string;
  },
): Promise<void> {
  const phoneDigits = input.recipientPhone.replace(/\D/g, '');
  const code = input.code.replace(/\D/g, '');
  if (code.length !== 6) {
    throw Object.assign(new Error('Payout OTP must be 6 digits'), {
      status: 400,
      code: 'PAYOUT_OTP_INVALID',
    });
  }
  const locked = await client.query<{
    id: string;
    code_hash: string;
    phone_hash: string;
    expires_at: string;
    failed_attempts: number;
    locked_until: string | null;
  }>(
    `SELECT id, code_hash, phone_hash, expires_at, failed_attempts, locked_until
       FROM cash_send_payout_otps
      WHERE voucher_id = $1 AND consumed_at IS NULL
      ORDER BY created_at DESC
      FOR UPDATE`,
    [input.voucherId],
  );
  const row = locked.rows[0];
  if (!row) {
    await recordOtpSecurityEvent(client, {
      voucherId: input.voucherId,
      outcome: 'missing',
      actorUserId: input.actorUserId,
      ipHash: input.ipHash,
      deviceHash: input.deviceHash,
    });
    throw Object.assign(new Error('Valid payout OTP is required when no recipient ID was captured at create'), {
      status: 401,
      code: 'PAYOUT_OTP_REQUIRED',
    });
  }
  if (row.locked_until && Date.parse(row.locked_until) > Date.now()) {
    await recordOtpSecurityEvent(client, {
      voucherId: input.voucherId,
      outcome: 'locked',
      actorUserId: input.actorUserId,
      ipHash: input.ipHash,
      deviceHash: input.deviceHash,
    });
    throw Object.assign(new Error('Payout for this voucher is temporarily locked after failed OTP attempts'), {
      status: 423,
      code: 'PAYOUT_OTP_LOCKED',
    });
  }
  if (Date.parse(row.expires_at) <= Date.now()) {
    await client.query(
      `UPDATE cash_send_payout_otps SET consumed_at = clock_timestamp() WHERE id = $1 AND consumed_at IS NULL`,
      [row.id],
    );
    await recordOtpSecurityEvent(client, {
      voucherId: input.voucherId,
      outcome: 'expired',
      actorUserId: input.actorUserId,
      ipHash: input.ipHash,
      deviceHash: input.deviceHash,
    });
    throw Object.assign(new Error('Payout OTP has expired. Request a new code.'), {
      status: 401,
      code: 'PAYOUT_OTP_EXPIRED',
    });
  }

  const expectedHash = hashCashSendPayoutOtp(input.voucherId, phoneDigits, code);
  const phoneHash = hashCashSendPayoutPhone(phoneDigits);
  if (row.code_hash !== expectedHash || row.phone_hash !== phoneHash) {
    const attempts = row.failed_attempts + 1;
    const lockUntil =
      attempts >= CASH_SEND_PAYOUT_OTP_MAX_FAILED
        ? new Date(Date.now() + CASH_SEND_PAYOUT_OTP_LOCK_MS).toISOString()
        : null;
    await client.query(
      `UPDATE cash_send_payout_otps
          SET failed_attempts = $2, locked_until = COALESCE($3::timestamptz, locked_until)
        WHERE id = $1`,
      [row.id, attempts, lockUntil],
    );
    await recordOtpSecurityEvent(client, {
      voucherId: input.voucherId,
      outcome: lockUntil ? 'locked_after_failures' : 'invalid',
      actorUserId: input.actorUserId,
      ipHash: input.ipHash,
      deviceHash: input.deviceHash,
    });
    throw Object.assign(
      new Error(
        lockUntil
          ? 'Too many incorrect payout OTP attempts. Collection is temporarily locked.'
          : 'Incorrect payout OTP.',
      ),
      {
        status: lockUntil ? 423 : 401,
        code: lockUntil ? 'PAYOUT_OTP_LOCKED' : 'PAYOUT_OTP_INVALID',
      },
    );
  }

  const consumed = await client.query(
    `UPDATE cash_send_payout_otps
        SET consumed_at = clock_timestamp()
      WHERE id = $1 AND consumed_at IS NULL`,
    [row.id],
  );
  if (!consumed.rowCount) {
    await recordOtpSecurityEvent(client, {
      voucherId: input.voucherId,
      outcome: 'replay',
      actorUserId: input.actorUserId,
      ipHash: input.ipHash,
      deviceHash: input.deviceHash,
    });
    throw Object.assign(new Error('This payout OTP has already been used'), {
      status: 409,
      code: 'PAYOUT_OTP_REPLAY',
    });
  }
  await recordOtpSecurityEvent(client, {
    voucherId: input.voucherId,
    outcome: 'consumed',
    actorUserId: input.actorUserId,
    ipHash: input.ipHash,
    deviceHash: input.deviceHash,
  });
}
