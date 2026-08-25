import { createHash, randomInt, randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { PIN_RESET_PEPPER } from '../config.js';
import { sendSms } from './sms.js';

type Db = Pool | PoolClient;

export const CASH_SEND_PAYOUT_OTP_TTL_MS = 10 * 60_000;

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

export async function issueCashSendPayoutOtpPg(
  database: Db,
  input: { voucherId: string; recipientPhone: string; referenceNumber?: string },
): Promise<{ expiresAt: string; sent: boolean }> {
  const phoneDigits = input.recipientPhone.replace(/\D/g, '');
  if (!phoneDigits) {
    throw Object.assign(new Error('Recipient phone is missing'), { status: 400 });
  }
  const code = generateCashSendPayoutOtpCode();
  const expiresAt = new Date(Date.now() + CASH_SEND_PAYOUT_OTP_TTL_MS).toISOString();
  await database.query(
    `UPDATE cash_send_payout_otps
        SET consumed_at = clock_timestamp()
      WHERE voucher_id = $1 AND consumed_at IS NULL`,
    [input.voucherId],
  );
  await database.query(
    `INSERT INTO cash_send_payout_otps
       (id, voucher_id, phone_hash, code_hash, expires_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [
      randomUUID(),
      input.voucherId,
      hashCashSendPayoutPhone(phoneDigits),
      hashCashSendPayoutOtp(input.voucherId, phoneDigits, code),
      expiresAt,
    ],
  );
  const hint = input.referenceNumber ? ` Voucher ${input.referenceNumber}.` : '';
  await sendSms(
    phoneDigits,
    `KasiPay cash collect code: ${code}. Expires in 10 minutes.${hint} Do not share it.`,
  );
  return { expiresAt, sent: true };
}

export async function consumeCashSendPayoutOtpPg(
  client: PoolClient,
  input: { voucherId: string; recipientPhone: string; code: string },
): Promise<void> {
  const phoneDigits = input.recipientPhone.replace(/\D/g, '');
  const code = input.code.replace(/\D/g, '');
  if (code.length !== 6) {
    throw Object.assign(new Error('Payout OTP must be 6 digits'), {
      status: 400,
      code: 'PAYOUT_OTP_INVALID',
    });
  }
  const locked = await client.query<{ id: string }>(
    `SELECT id FROM cash_send_payout_otps
      WHERE voucher_id = $1
        AND phone_hash = $2
        AND code_hash = $3
        AND consumed_at IS NULL
        AND expires_at > clock_timestamp()
      ORDER BY created_at DESC
      FOR UPDATE
      LIMIT 1`,
    [
      input.voucherId,
      hashCashSendPayoutPhone(phoneDigits),
      hashCashSendPayoutOtp(input.voucherId, phoneDigits, code),
    ],
  );
  if (!locked.rows[0]) {
    throw Object.assign(new Error('Valid payout OTP is required when no recipient ID was captured at create'), {
      status: 401,
      code: 'PAYOUT_OTP_REQUIRED',
    });
  }
  await client.query(
    `UPDATE cash_send_payout_otps
        SET consumed_at = clock_timestamp()
      WHERE id = $1 AND consumed_at IS NULL`,
    [locked.rows[0].id],
  );
}
