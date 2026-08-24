import type { Pool, PoolClient } from 'pg';

import { parseIntegerCents, type Cents } from '../money.js';
import { assertPhysicalCashForPayoutPg } from './cashAvailabilityPg.js';
import { ensureMerchantFloatWalletPg, getMerchantFloatWalletPg } from './walletKindsPg.js';

type Db = Pool | PoolClient;

export type PayoutAgentStatus = 'pending' | 'enrolled' | 'approved' | 'suspended' | 'rejected';

const ACCEPTABLE_KYC = new Set(['verified', 'approved']);
const COMPLETE_ACTIVATION = new Set(['paid', 'waived', 'complete']);

export function kycIsAcceptable(status: string | null | undefined): boolean {
  return Boolean(status && ACCEPTABLE_KYC.has(status));
}

export function activationIsComplete(status: string | null | undefined): boolean {
  return Boolean(status && COMPLETE_ACTIVATION.has(status));
}

export async function assertMerchantAgentReadyPg(
  database: Db,
  merchantUserId: string,
): Promise<{ merchantId: string }> {
  const merchant = await database.query<{
    merchant_id: string;
    approval_status: string;
    activation: string | null;
    kyc: string | null;
  }>(
    `SELECT m.id AS merchant_id,
            m.approval_status,
            (SELECT status FROM merchant_activations a WHERE a.merchant_id = m.user_id) AS activation,
            u.kyc_status AS kyc
       FROM merchants m
       JOIN users u ON u.id = m.user_id
      WHERE m.user_id = $1`,
    [merchantUserId],
  );
  const row = merchant.rows[0];
  if (!row || row.approval_status !== 'approved') {
    throw Object.assign(new Error('Merchant must be approved before agent cash movement'), {
      status: 403,
      code: 'MERCHANT_NOT_APPROVED',
    });
  }
  if (!activationIsComplete(row.activation)) {
    throw Object.assign(new Error('Merchant activation must be complete'), {
      status: 403,
      code: 'MERCHANT_ACTIVATION_INCOMPLETE',
    });
  }
  if (!kycIsAcceptable(row.kyc)) {
    throw Object.assign(new Error('KYC/KYB must be verified before agent cash movement'), {
      status: 403,
      code: 'KYC_NOT_VERIFIED',
    });
  }
  return { merchantId: row.merchant_id };
}

export async function applyPayoutAgentPg(
  database: Db,
  merchantUserId: string,
): Promise<{ status: PayoutAgentStatus }> {
  await assertMerchantAgentReadyPg(database, merchantUserId);
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

/** Cash-in: debit dedicated merchant_float. Electronic float must cover principal+fee. */
export async function assertAgentCanSendPg(
  database: Db,
  merchantUserId: string,
  totalCents: Cents,
): Promise<{ floatWalletId: string }> {
  await assertMerchantAgentReadyPg(database, merchantUserId);
  const amount = parseIntegerCents(totalCents);
  const float = await getMerchantFloatWalletPg(database, merchantUserId);
  if (!float || float.status !== 'active') {
    throw Object.assign(new Error('Merchant float wallet is required for cash-in'), {
      status: 400,
      code: 'FLOAT_WALLET_REQUIRED',
    });
  }
  const available = parseIntegerCents(float.balance_cents ?? '0', { allowZero: true });
  if (available < amount) {
    throw Object.assign(new Error('Merchant float is insufficient for this Cash Send'), {
      status: 400,
      code: 'FLOAT_INSUFFICIENT',
    });
  }
  return { floatWalletId: float.id };
}

/**
 * Cash-out: physical cash on hand is the eligibility gate.
 * Electronic float is credited after payout; a float floor is not sufficient
 * and is not required to pay.
 */
export async function assertPayoutAgentCanPayPg(
  database: Db,
  merchantUserId: string,
  amountCents: Cents,
): Promise<{ floatWalletId: string; merchantId: string }> {
  const amount = parseIntegerCents(amountCents);
  const { merchantId } = await assertMerchantAgentReadyPg(database, merchantUserId);
  const agent = await database.query<{
    status: string;
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
  const dailyLimit = BigInt(row.daily_payout_limit_cents);
  if (used + amount > dailyLimit) {
    throw Object.assign(new Error('Daily payout limit exceeded'), {
      status: 400,
      code: 'PAYOUT_DAILY_LIMIT',
    });
  }
  await assertPhysicalCashForPayoutPg(database, merchantId, amount);
  const float = await getMerchantFloatWalletPg(database, merchantUserId);
  if (!float || float.status !== 'active') {
    throw Object.assign(new Error('Merchant float wallet is required for cash-out credit'), {
      status: 400,
      code: 'FLOAT_WALLET_REQUIRED',
    });
  }
  return { floatWalletId: float.id, merchantId };
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
