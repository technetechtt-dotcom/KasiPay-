import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import type { Pool, PoolClient } from 'pg';

import { structuredLog } from '../observability.js';
import { disablePostingOnLedgerDriftPg } from './driftPostingGuardPg.js';
import { inventoryWalletLedgerDriftPg } from './walletLedgerAlignmentPg.js';

export type ReconcileRunType =
  | 'wallet_ledger'
  | 'money_columns'
  | 'journal'
  | 'vouchers'
  | 'full';

function runScript(script: string): { exit: number } {
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: process.env,
  });
  return { exit: result.status ?? 1 };
}

export async function runScheduledReconciliationPg(
  pool: Pool,
  input: {
    runType?: ReconcileRunType;
    triggeredBy?: string;
  } = {},
): Promise<{ runId: string; ok: boolean; driftedWallets: number }> {
  const runType = input.runType ?? 'full';
  const runId = randomUUID();
  await pool.query(
    `INSERT INTO reconciliation_runs (id, run_type, state, triggered_by)
     VALUES ($1,$2,'running',$3)`,
    [runId, runType, input.triggeredBy ?? 'scheduler'],
  );

  const checks: Record<string, { exit: number }> = {};
  if (runType === 'full' || runType === 'wallet_ledger') {
    checks.walletLedger = runScript('scripts/inventory-wallet-ledger-drift.mjs');
  }
  if (runType === 'full' || runType === 'money_columns') {
    checks.money = runScript('scripts/reconcile-money.mjs');
  }
  if (runType === 'full' || runType === 'journal') {
    checks.journal = runScript('scripts/reconcile-ledger.mjs');
  }
  if (runType === 'full' || runType === 'vouchers') {
    checks.vouchers = runScript('scripts/reconcile-vouchers.mjs');
  }

  const driftClient = await pool.connect();
  let driftRows;
  try {
    driftRows = await inventoryWalletLedgerDriftPg(driftClient);
  } finally {
    driftClient.release();
  }

  if (driftRows.length > 0) {
    await disablePostingOnLedgerDriftPg(pool);
    for (const row of driftRows.slice(0, 100)) {
      await pool.query(
        `INSERT INTO reconciliation_exceptions
           (id, run_id, exception_type, severity, subject_type, subject_id, summary, evidence)
         VALUES ($1,$2,'wallet_ledger_drift','critical','wallet',$3,$4,$5::jsonb)`,
        [
          randomUUID(),
          runId,
          row.walletId,
          `Wallet/ledger delta ${row.deltaCents.toString()} (${row.origin})`,
          JSON.stringify({
            balanceCents: row.balanceCents.toString(),
            legacyLedgerCents: row.legacyLedgerCents.toString(),
            deltaCents: row.deltaCents.toString(),
            origin: row.origin,
          }),
        ],
      );
    }
    structuredLog('error', 'reconciliation.drift_detected', {
      runId,
      driftedWallets: driftRows.length,
      alert: true,
    });
  }

  const softFailures = Object.entries(checks)
    .filter(([name, v]) => name === 'journal' && v.exit !== 0)
    .map(([name]) => name);
  const hardFail =
    driftRows.length > 0 ||
    Boolean(checks.walletLedger && checks.walletLedger.exit !== 0) ||
    Boolean(checks.money && checks.money.exit !== 0) ||
    Boolean(checks.vouchers && checks.vouchers.exit !== 0);

  const state = hardFail ? 'failed' : softFailures.length ? 'partial' : 'passed';
  await pool.query(
    `UPDATE reconciliation_runs
        SET state = $2, completed_at = clock_timestamp(), report = $3::jsonb
      WHERE id = $1`,
    [
      runId,
      state,
      JSON.stringify({
        checks,
        driftedWallets: driftRows.length,
        softFailures,
      }),
    ],
  );

  return { runId, ok: !hardFail, driftedWallets: driftRows.length };
}

export async function listOpenReconciliationExceptionsPg(
  database: Pool | PoolClient,
  limit = 100,
) {
  const result = await database.query(
    `SELECT * FROM reconciliation_exceptions
      WHERE state IN ('open','assigned','in_progress')
      ORDER BY CASE severity
        WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        created_at ASC
      LIMIT $1`,
    [limit],
  );
  return result.rows;
}
