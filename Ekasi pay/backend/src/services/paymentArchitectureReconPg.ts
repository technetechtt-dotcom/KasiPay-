import type { PoolClient } from 'pg';

import { observeMetric } from '../observability.js';

export type ArchitectureCheck = {
  name: string;
  ok: boolean;
  critical: boolean;
  detail: Record<string, unknown>;
};

export async function checkMerchantFloatLedgerPg(
  database: PoolClient,
): Promise<ArchitectureCheck> {
  const exists = await database.query<{ ok: boolean }>(
    `SELECT to_regclass('public.wallets') IS NOT NULL AS ok`,
  );
  if (!exists.rows[0]?.ok) {
    return { name: 'merchant_float', ok: true, critical: true, detail: { skipped: true } };
  }
  const drift = await database.query<{ drifted: number }>(`
    SELECT count(*)::int AS drifted
      FROM wallets w
      JOIN ledger_accounts a ON a.wallet_id = w.id
      JOIN account_balance_projections p ON p.account_id = a.id
     WHERE w.wallet_kind = 'merchant_float'
       AND w.balance_cents <> p.available_cents
  `);
  const drifted = drift.rows[0]?.drifted ?? 0;
  if (drifted > 0) observeMetric('ledger.drift');
  return {
    name: 'merchant_float',
    ok: drifted === 0,
    critical: true,
    detail: { driftedWallets: drifted },
  };
}

export async function checkEscrowVouchersPg(
  database: PoolClient,
): Promise<ArchitectureCheck> {
  const exists = await database.query<{ ok: boolean }>(
    `SELECT to_regclass('public.cash_send_vouchers') IS NOT NULL AS ok`,
  );
  if (!exists.rows[0]?.ok) {
    return { name: 'escrow_vouchers', ok: true, critical: true, detail: { skipped: true } };
  }
  const row = await database.query<{ outstanding: string; escrow: string }>(`
    SELECT
      (SELECT COALESCE(sum(amount_cents),0)::text FROM cash_send_vouchers WHERE status = 'active') AS outstanding,
      (SELECT COALESCE(sum(balance_cents),0)::text FROM wallets WHERE wallet_kind = 'system_escrow') AS escrow
  `);
  const outstanding = BigInt(row.rows[0]?.outstanding ?? '0');
  const escrow = BigInt(row.rows[0]?.escrow ?? '0');
  const ok = escrow >= outstanding;
  if (!ok) observeMetric('ledger.drift');
  return {
    name: 'escrow_vouchers',
    ok,
    critical: true,
    detail: {
      outstandingPrincipalCents: outstanding.toString(),
      escrowBalanceCents: escrow.toString(),
    },
  };
}

export async function checkSafeguardingLatestPg(
  database: PoolClient,
): Promise<ArchitectureCheck> {
  const exists = await database.query<{ ok: boolean }>(
    `SELECT to_regclass('public.safeguarding_reconciliations') IS NOT NULL AS ok`,
  );
  if (!exists.rows[0]?.ok) {
    return { name: 'safeguarding', ok: true, critical: true, detail: { skipped: true } };
  }
  const latest = await database.query<{ status: string }>(
    `SELECT status FROM safeguarding_reconciliations ORDER BY generated_at DESC LIMIT 1`,
  );
  const status = latest.rows[0]?.status ?? 'unknown';
  const ok = status !== 'shortfall';
  if (!ok) observeMetric('safeguarding.shortfall');
  return {
    name: 'safeguarding',
    ok,
    critical: true,
    detail: { latestStatus: status },
  };
}
