import type { Pool, PoolClient } from 'pg';

import { parseIntegerCents, type Cents } from '../money.js';
import { ensureMerchantFloatWalletPg, getMerchantFloatWalletPg } from './walletKindsPg.js';

type Db = Pool | PoolClient;

export type PayoutAgentStatus = 'pending' | 'enrolled' | 'approved' | 'suspended' | 'rejected';

export async function applyPayoutAgentPg(
  database: Db,
  merchantUserId: string,
): Promise<{ status: PayoutAgentStatus }> {
  const merchant = await database.query<{
    approval_status: string;
    activation: string | null;
    kyc: string;
  }>(
    `SELECT m.approval_status,
            (SELECT status FROM merchant_activations a WHERE a.merchant_id = m.id) AS activation,
            u.kyc_status AS kyc
       FROM merchants m
       JOIN users u ON u.id = m.user_id
      WHERE m.user_id = $1`,
    [merchantUserId],
  );
  const row = merchant.rows[0];
  if (!row || row.approval_status !== 'approved') {
    throw Object.assign(new Error('Merchant must be approved before applying as a payout agent'), {
      status: 403,
    });
  }
  if (row.activation && !['paid', 'waived', 'complete'].includes(row.activation)) {
    throw Object.assign(new Error('Merchant activation must be complete'), { status: 403 });
  }
  if (row.kyc && ['rejected', 'blocked'].includes(row.kyc)) {
    throw Object.assign(new Error('KYC/KYB status is not acceptable'), { status: 403 });
  }
  await ensureMerchantFloatWalletPg(database, merchantUserId);
  await database.query(
    `INSERT INTO payout_agents (merchant_id, status)
     VALUES ($1, 'pending')
     ON CONFLICT (merchant_id) DO UPDATE
       SET updated_at = clock_timestamp()
     WHERE payout_agents.status IN ('pending','rejected')`,
    [merchantUserId],
  );
  await database.query(
    `INSERT INTO merchant_float_limits (merchant_user_id)
     VALUES ($1) ON CONFLICT (merchant_user_id) DO NOTHING`,
    [merchantUserId],
  );
  const status = await database.query<{ status: PayoutAgentStatus }>(
    `SELECT status FROM payout_agents WHERE merchant_id = $1`,
    [merchantUserId],
  );
  return { status: status.rows[0]?.status ?? 'pending' };
}

export async function setPayoutAgentStatusPg(
  database: Db,
  merchantUserId: string,
  status: Exclude<PayoutAgentStatus, 'pending'>,
  reviewer: string,
  reason?: string,
): Promise<void> {
  const result = await database.query(
    `UPDATE payout_agents
        SET status = $2, reviewed_by = $3, reviewed_at = clock_timestamp(),
            reject_reason = $4, enrolled_at = CASE
              WHEN $2 IN ('enrolled','approved') THEN COALESCE(enrolled_at, clock_timestamp())
              ELSE enrolled_at END,
            updated_at = clock_timestamp()
      WHERE merchant_id = $1`,
    [merchantUserId, status === 'approved' ? 'enrolled' : status, reviewer, reason ?? null],
  );
  if (!result.rowCount) {
    throw Object.assign(new Error('Payout agent not found'), { status: 404 });
  }
}

export async function assertPayoutAgentCanPayPg(
  database: Db,
  merchantUserId: string,
  amountCents: Cents,
): Promise<{ floatWalletId: string }> {
  const amount = parseIntegerCents(amountCents);
  const agent = await database.query<{
    status: string;
    float_floor_cents: string;
    per_transaction_limit_cents: string;
    daily_payout_limit_cents: string;
    daily_payout_used_cents: string;
    daily_payout_used_on: string | null;
    float_suspended: boolean;
  }>(`SELECT * FROM payout_agents WHERE merchant_id = $1`, [merchantUserId]);
  const row = agent.rows[0];
  if (!row || !['enrolled', 'approved'].includes(row.status)) {
    throw Object.assign(new Error('Payout agent is not enrolled'), {
      status: 403,
      code: 'PAYOUT_AGENT_NOT_ENROLLED',
    });
  }
  if (row.status === 'suspended' || row.float_suspended) {
    throw Object.assign(new Error('Payout agent is suspended'), {
      status: 403,
      code: 'PAYOUT_AGENT_SUSPENDED',
    });
  }
  if (amount > BigInt(row.per_transaction_limit_cents)) {
    throw Object.assign(new Error('Payout exceeds per-transaction limit'), {
      status: 400,
      code: 'PAYOUT_TX_LIMIT',
    });
  }
  const usedOn = row.daily_payout_used_on;
  const today = new Date().toISOString().slice(0, 10);
  const used = usedOn === today ? BigInt(row.daily_payout_used_cents) : 0n;
  if (used + amount > BigInt(row.daily_payout_limit_cents || row.daily_payout_used_cents)) {
    const dailyLimit = BigInt(row.daily_payout_limit_cents);
    if (used + amount > dailyLimit) {
      throw Object.assign(new Error('Daily payout limit exceeded'), {
        status: 400,
        code: 'PAYOUT_DAILY_LIMIT',
      });
    }
  }
  const float = await getMerchantFloatWalletPg(database, merchantUserId);
  if (!float || float.status !== 'active') {
    throw Object.assign(new Error('Merchant float wallet is required for cash-out'), {
      status: 400,
      code: 'FLOAT_WALLET_REQUIRED',
    });
  }
  const available = parseIntegerCents(float.balance_cents ?? '0', { allowZero: true });
  if (available < BigInt(row.float_floor_cents)) {
    throw Object.assign(new Error('Float is below the configured floor'), {
      status: 400,
      code: 'FLOAT_FLOOR',
    });
  }
  return { floatWalletId: float.id };
}

export async function recordPayoutUsagePg(
  database: Db,
  merchantUserId: string,
  amountCents: Cents,
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  await database.query(
    `UPDATE payout_agents
        SET daily_payout_used_cents = CASE
              WHEN daily_payout_used_on = $2::date THEN daily_payout_used_cents + $3
              ELSE $3 END,
            daily_payout_used_on = $2::date,
            updated_at = clock_timestamp()
      WHERE merchant_id = $1`,
    [merchantUserId, today, amountCents.toString()],
  );
}

export async function listPayoutAgentsPg(database: Db) {
  const rows = await database.query(
    `SELECT pa.*, w.balance_cents AS float_balance_cents
       FROM payout_agents pa
       LEFT JOIN wallets w
         ON w.user_id = pa.merchant_id AND w.wallet_kind = 'merchant_float'
      ORDER BY pa.updated_at DESC
      LIMIT 200`,
  );
  return rows.rows;
}
