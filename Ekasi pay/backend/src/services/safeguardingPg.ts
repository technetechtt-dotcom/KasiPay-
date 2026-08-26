import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { observeMetric, structuredLog } from '../observability.js';
import { disableFinancialPostingPg } from './driftPostingGuardPg.js';

type Db = Pool | PoolClient;

export type SafeguardingStatus = 'balanced' | 'shortfall' | 'surplus' | 'unknown';

export type SafeguardingReport = {
  id: string;
  poolId: string;
  currency: string;
  expectedClientFundsCents: bigint;
  actualClientFundsCents: bigint | null;
  differenceCents: bigint | null;
  status: SafeguardingStatus;
  generatedAt: string;
  breakdown: {
    merchantFloatLiabilitiesCents: bigint;
    customerWalletLiabilitiesCents: bigint;
    outstandingCashSendPrincipalCents: bigint;
    otherProtectedLiabilitiesCents: bigint;
    operatingRevenueExcludedCents: bigint;
  };
};

export function classifySafeguarding(input: {
  expectedClientFundsCents: bigint;
  actualClientFundsCents: bigint | null;
}): { status: SafeguardingStatus; differenceCents: bigint | null } {
  if (input.actualClientFundsCents === null) {
    return { status: 'unknown', differenceCents: null };
  }
  const difference = input.actualClientFundsCents - input.expectedClientFundsCents;
  if (difference === 0n) return { status: 'balanced', differenceCents: 0n };
  if (difference < 0n) return { status: 'shortfall', differenceCents: difference };
  return { status: 'surplus', differenceCents: difference };
}

export async function generateSafeguardingReportPg(
  database: Db,
  input: { poolId?: string; currency?: string; actualClientFundsCents?: bigint | null } = {},
): Promise<SafeguardingReport> {
  const poolId = input.poolId ?? 'ZA';
  const currency = input.currency ?? 'ZAR';
  const float = await database.query<{ cents: string }>(
    `SELECT COALESCE(sum(balance_cents),0)::text AS cents
       FROM wallets
      WHERE wallet_kind = 'merchant_float' AND currency = $1
        AND COALESCE(pool_id,'ZA') = $2`,
    [currency, poolId],
  );
  const customers = await database.query<{ cents: string }>(
    `SELECT COALESCE(sum(balance_cents),0)::text AS cents
       FROM wallets
      WHERE COALESCE(wallet_kind,'user') = 'user' AND currency = $1
        AND COALESCE(pool_id,'ZA') = $2 AND COALESCE(status,'active') = 'active'`,
    [currency, poolId],
  );
  const vouchers = await database.query<{ cents: string }>(
    `SELECT COALESCE(sum(v.amount_cents),0)::text AS cents
       FROM cash_send_vouchers v
       JOIN wallets w ON w.user_id = v.sender_user_id AND COALESCE(w.wallet_kind,'user') = 'user'
      WHERE v.status = 'active' AND COALESCE(w.pool_id,'ZA') = $1`,
    [poolId],
  );
  const escrow = await database.query<{ cents: string }>(
    `SELECT COALESCE(sum(balance_cents),0)::text AS cents
       FROM wallets
      WHERE wallet_kind = 'system_escrow' AND currency = $1
        AND COALESCE(pool_id,'ZA') = $2`,
    [currency, poolId],
  );
  const earned = await database.query<{ cents: string }>(
    `SELECT COALESCE(sum(amount_cents),0)::text AS cents
       FROM fee_lifecycle_events
      WHERE component = 'platform' AND state IN ('earned','swept')`,
  );

  const merchantFloatLiabilitiesCents = BigInt(float.rows[0]?.cents ?? '0');
  const customerWalletLiabilitiesCents = BigInt(customers.rows[0]?.cents ?? '0');
  const outstandingCashSendPrincipalCents = BigInt(vouchers.rows[0]?.cents ?? '0');
  const otherProtectedLiabilitiesCents = BigInt(escrow.rows[0]?.cents ?? '0');
  const operatingRevenueExcludedCents = BigInt(earned.rows[0]?.cents ?? '0');
  const expectedClientFundsCents =
    merchantFloatLiabilitiesCents +
    customerWalletLiabilitiesCents +
    outstandingCashSendPrincipalCents;
  const imported =
    input.actualClientFundsCents === undefined
      ? await latestClientFundsBankBalancePg(database, { poolId, currency }).catch(() => null)
      : input.actualClientFundsCents;
  const actual = imported === undefined ? null : imported;
  const classified = classifySafeguarding({
    expectedClientFundsCents,
    actualClientFundsCents: actual,
  });
  const id = randomUUID();
  const generatedAt = new Date().toISOString();
  await database.query(
    `INSERT INTO safeguarding_reconciliations
       (id, pool_id, currency, expected_client_funds_cents, actual_client_funds_cents,
        difference_cents, status, report, generated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
    [
      id,
      poolId,
      currency,
      expectedClientFundsCents.toString(),
      actual === null ? null : actual.toString(),
      classified.differenceCents === null ? null : classified.differenceCents.toString(),
      classified.status,
      JSON.stringify({
        merchantFloatLiabilitiesCents: merchantFloatLiabilitiesCents.toString(),
        customerWalletLiabilitiesCents: customerWalletLiabilitiesCents.toString(),
        outstandingCashSendPrincipalCents: outstandingCashSendPrincipalCents.toString(),
        otherProtectedLiabilitiesCents: otherProtectedLiabilitiesCents.toString(),
        operatingRevenueExcludedCents: operatingRevenueExcludedCents.toString(),
      }),
      generatedAt,
    ],
  );

  if (classified.status === 'shortfall') {
    observeMetric('safeguarding.shortfall');
    structuredLog('error', 'safeguarding.shortfall', {
      reportId: id,
      expectedClientFundsCents: expectedClientFundsCents.toString(),
      actualClientFundsCents: actual?.toString() ?? null,
      differenceCents: classified.differenceCents?.toString() ?? null,
      alert: true,
      severity: 'CRITICAL',
    });
    await disableFinancialPostingPg(
      database,
      `Safeguarding shortfall ${classified.differenceCents} ${currency} pool ${poolId}`,
    );
  }

  return {
    id,
    poolId,
    currency,
    expectedClientFundsCents,
    actualClientFundsCents: actual,
    differenceCents: classified.differenceCents,
    status: classified.status,
    generatedAt,
    breakdown: {
      merchantFloatLiabilitiesCents,
      customerWalletLiabilitiesCents,
      outstandingCashSendPrincipalCents,
      otherProtectedLiabilitiesCents,
      operatingRevenueExcludedCents,
    },
  };
}

export async function importSafeguardingBankBalancePg(
  database: Db,
  input: {
    bankAccountId: string;
    asOf: string;
    availableCents: bigint;
    source: string;
    importedBy: string;
  },
): Promise<{ id: string }> {
  const id = randomUUID();
  await database.query(
    `INSERT INTO bank_account_balances
       (id, bank_account_id, as_of, available_cents, source, imported_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (bank_account_id, as_of, source)
     DO UPDATE SET available_cents = EXCLUDED.available_cents, imported_by = EXCLUDED.imported_by`,
    [
      id,
      input.bankAccountId,
      input.asOf,
      input.availableCents.toString(),
      input.source,
      input.importedBy,
    ],
  );
  return { id };
}

export async function latestClientFundsBankBalancePg(
  database: Db,
  input: { poolId?: string; currency?: string } = {},
): Promise<bigint | null> {
  const row = await database.query<{ available_cents: string }>(
    `SELECT b.available_cents
       FROM bank_account_balances b
       JOIN bank_accounts a ON a.id = b.bank_account_id
      WHERE a.purpose = 'client_funds'
        AND a.currency = $1
        AND a.pool_id = $2
        AND a.approved = TRUE
      ORDER BY b.as_of DESC, b.created_at DESC
      LIMIT 1`,
    [input.currency ?? 'ZAR', input.poolId ?? 'ZA'],
  );
  return row.rows[0] ? BigInt(row.rows[0].available_cents) : null;
}

export async function signOffSafeguardingReportPg(
  database: Db,
  input: { reportId: string; operatorId: string; note?: string },
): Promise<{ id: string }> {
  const report = await database.query<{ id: string }>(
    `SELECT id FROM safeguarding_reconciliations WHERE id = $1`,
    [input.reportId],
  );
  if (!report.rows[0]) {
    throw Object.assign(new Error('Safeguarding report not found'), { status: 404 });
  }
  const id = randomUUID();
  await database.query(
    `INSERT INTO safeguarding_signoffs (id, report_id, operator_id, note)
     VALUES ($1,$2,$3,$4)`,
    [id, input.reportId, input.operatorId, input.note ?? null],
  );
  return { id };
}
