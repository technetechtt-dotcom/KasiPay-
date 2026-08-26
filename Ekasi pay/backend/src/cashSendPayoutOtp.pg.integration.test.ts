import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Pool } from 'pg';

import {
  consumeCashSendPayoutOtpPg,
  hashCashSendPayoutOtp,
  hashCashSendPayoutPhone,
  issueCashSendPayoutOtpPg,
} from './services/cashSendPayoutOtpPg.js';

const connectionString = process.env.TEST_DATABASE_URL;
const enabled = process.env.PG_INTEGRATION_TESTS === '1' && Boolean(connectionString);

async function seedVoucher(pool: Pool, suffix: string) {
  const userId = `otp-user-${suffix}`;
  const voucherId = randomUUID();
  const phone = `082${suffix.replaceAll('-', '').slice(0, 7)}`.slice(0, 10);
  await pool.query(
    `INSERT INTO users
       (id,name,phone,pin_hash,role,kyc_status,account_tier,created_at,country_code,is_system)
     VALUES ($1,'Otp',$2,'x','merchant','verified','Basic',clock_timestamp(),'ZA',0)`,
    [userId, `+27${suffix.replaceAll('-', '').slice(0, 9)}`],
  );
  await pool.query(
    `INSERT INTO cash_send_vouchers
       (id, sender_user_id, sender_phone, sender_first_name, sender_last_name,
        sender_id_document_encrypted, sender_address_encrypted, recipient_phone,
        recipient_first_name, recipient_last_name, recipient_id_document_encrypted,
        amount_cents, fee_cents, pin_hash, reference_number, status, created_at, expires_at)
     VALUES ($1,$2,$3,'A','B','enc-id','enc-addr',$3,'C','D','enc-rid',10000,900,'x',$4,
             'active',clock_timestamp(), clock_timestamp() + interval '14 days')`,
    [voucherId, userId, phone, `CS${suffix.replaceAll('-', '').slice(0, 16).toUpperCase()}`],
  );
  return { userId, voucherId, phone };
}

test('cash send payout OTP postgres', { skip: !enabled }, async (suite) => {
  const pool = new Pool({ connectionString, max: 8 });
  suite.after(async () => pool.end());

  await suite.test('keeps only one active OTP per voucher', async () => {
    const suffix = randomUUID();
    const { voucherId, phone } = await seedVoucher(pool, suffix);
    await issueCashSendPayoutOtpPg(pool, { voucherId, recipientPhone: phone });
    await issueCashSendPayoutOtpPg(pool, { voucherId, recipientPhone: phone }).then(
      () => {
        throw new Error('second OTP issued inside cooldown');
      },
      (error: { code?: string }) => {
        assert.equal(error.code, 'PAYOUT_OTP_COOLDOWN');
      },
    );
    const active = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM cash_send_payout_otps
        WHERE voucher_id = $1 AND consumed_at IS NULL`,
      [voucherId],
    );
    assert.equal(Number(active.rows[0]?.n ?? 0), 1);
  });

  await suite.test('concurrent issuance leaves a single active OTP', async () => {
    const suffix = randomUUID();
    const { voucherId, phone } = await seedVoucher(pool, suffix);
    await Promise.allSettled([
      issueCashSendPayoutOtpPg(pool, { voucherId, recipientPhone: phone }),
      issueCashSendPayoutOtpPg(pool, { voucherId, recipientPhone: phone }),
    ]);
    const active = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM cash_send_payout_otps
        WHERE voucher_id = $1 AND consumed_at IS NULL`,
      [voucherId],
    );
    assert.equal(Number(active.rows[0]?.n ?? 0), 1);
  });

  await suite.test('locks after five failed attempts and rejects replay', async () => {
    const suffix = randomUUID();
    const { voucherId, phone } = await seedVoucher(pool, suffix);
    const code = '654321';
    await pool.query(
      `INSERT INTO cash_send_payout_otps
         (id, voucher_id, phone_hash, code_hash, expires_at, failed_attempts, send_count)
       VALUES ($1,$2,$3,$4,clock_timestamp() + interval '10 minutes',0,1)`,
      [
        randomUUID(),
        voucherId,
        hashCashSendPayoutPhone(phone.replace(/\D/g, '')),
        hashCashSendPayoutOtp(voucherId, phone.replace(/\D/g, ''), code),
      ],
    );
    const failClient = await pool.connect();
    try {
      for (let i = 0; i < 5; i += 1) {
        await failClient.query('BEGIN');
        await consumeCashSendPayoutOtpPg(failClient, {
          voucherId,
          recipientPhone: phone,
          code: '000000',
        }).then(
          () => {
            throw new Error('accepted wrong OTP');
          },
          (error: { code?: string }) => {
            assert.ok(error.code === 'PAYOUT_OTP_INVALID' || error.code === 'PAYOUT_OTP_LOCKED');
          },
        );
        await failClient.query('COMMIT');
      }
    } finally {
      failClient.release();
    }
    const locked = await pool.connect();
    try {
      await locked.query('BEGIN');
      await consumeCashSendPayoutOtpPg(locked, {
        voucherId,
        recipientPhone: phone,
        code,
      }).then(
        () => {
          throw new Error('accepted OTP after lock');
        },
        (error: { code?: string }) => {
          assert.equal(error.code, 'PAYOUT_OTP_LOCKED');
        },
      );
      await locked.query('ROLLBACK');
    } finally {
      locked.release();
    }
  });

  await suite.test('expired OTP cannot be consumed and replay is rejected', async () => {
    const suffix = randomUUID();
    const { voucherId, phone } = await seedVoucher(pool, suffix);
    const code = '111222';
    const otpId = randomUUID();
    await pool.query(
      `INSERT INTO cash_send_payout_otps
         (id, voucher_id, phone_hash, code_hash, expires_at, failed_attempts, send_count)
       VALUES ($1,$2,$3,$4,clock_timestamp() - interval '1 minute',0,1)`,
      [
        otpId,
        voucherId,
        hashCashSendPayoutPhone(phone.replace(/\D/g, '')),
        hashCashSendPayoutOtp(voucherId, phone.replace(/\D/g, ''), code),
      ],
    );
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await consumeCashSendPayoutOtpPg(client, {
        voucherId,
        recipientPhone: phone,
        code,
      }).then(
        () => {
          throw new Error('accepted expired OTP');
        },
        (error: { code?: string }) => {
          assert.equal(error.code, 'PAYOUT_OTP_EXPIRED');
        },
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });

  await suite.test('concurrent redemption of one OTP succeeds exactly once', async () => {
    const suffix = randomUUID();
    const { voucherId, phone } = await seedVoucher(pool, suffix);
    const code = '777888';
    await pool.query(
      `INSERT INTO cash_send_payout_otps
         (id, voucher_id, phone_hash, code_hash, expires_at, failed_attempts, send_count)
       VALUES ($1,$2,$3,$4,clock_timestamp() + interval '10 minutes',0,1)`,
      [
        randomUUID(),
        voucherId,
        hashCashSendPayoutPhone(phone.replace(/\D/g, '')),
        hashCashSendPayoutOtp(voucherId, phone.replace(/\D/g, ''), code),
      ],
    );
    const results = await Promise.all(
      [1, 2].map(async () => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await consumeCashSendPayoutOtpPg(client, {
            voucherId,
            recipientPhone: phone,
            code,
          });
          await client.query('COMMIT');
          return 'ok';
        } catch {
          await client.query('ROLLBACK');
          return 'fail';
        } finally {
          client.release();
        }
      }),
    );
    assert.equal(results.filter((row) => row === 'ok').length, 1);
    assert.equal(results.filter((row) => row === 'fail').length, 1);
  });
});
