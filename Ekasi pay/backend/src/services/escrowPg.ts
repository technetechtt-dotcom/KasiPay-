import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import { hashPin } from '../password.js';
import {
  DEFAULT_POOL_ID,
  ESCROW_SYSTEM_USER_ID_ZA,
  ESCROW_SYSTEM_USER_PHONE_ZA,
  currencyForPool,
} from '../poolConstants.js';

export async function getEscrowWalletIdForPoolPg(
  pool: Pool,
  poolId: string,
): Promise<string | undefined> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM wallets WHERE wallet_kind = 'system_escrow' AND pool_id = $1 LIMIT 1`,
    [poolId],
  );
  return r.rows[0]?.id;
}

export async function seedEscrowPoolZaPg(pool: Pool): Promise<void> {
  const existing = await getEscrowWalletIdForPoolPg(pool, DEFAULT_POOL_ID);
  if (existing) return;

  const now = new Date().toISOString();
  const poolId = DEFAULT_POOL_ID;
  const pinHash = hashPin('__KASIPAY_SYSTEM_ESCROW_NO_LOGIN__');
  const walletId = randomUUID();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const sysUser = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE id = $1`,
      [ESCROW_SYSTEM_USER_ID_ZA],
    );
    if (!sysUser.rows[0]) {
      await client.query(
        `INSERT INTO users (
          id, name, phone, pin_hash, role, kyc_status, account_tier, created_at,
          country_code, is_system
        ) VALUES ($1, $2, $3, $4, 'customer', 'verified', 'System', $5, $6, 1)`,
        [
          ESCROW_SYSTEM_USER_ID_ZA,
          'KasiPay network float (ZA)',
          ESCROW_SYSTEM_USER_PHONE_ZA,
          pinHash,
          now,
          poolId,
        ],
      );
    }

    await client.query(
      `INSERT INTO wallets (id, user_id, balance, currency, status, pool_id, wallet_kind)
       VALUES ($1, $2, 0, $3, 'active', $4, 'system_escrow')`,
      [walletId, ESCROW_SYSTEM_USER_ID_ZA, currencyForPool(poolId), poolId],
    );

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
