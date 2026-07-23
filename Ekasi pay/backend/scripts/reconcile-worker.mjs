/**
 * Dedicated reconciliation worker (cron / long-running).
 * Do not run full reconciliation inside the API process.
 *
 *   DATABASE_URL=... npm run reconcile:worker
 *   RECONCILE_ONCE=1 DATABASE_URL=... npm run reconcile:worker
 */
import 'dotenv/config';

import { closePg, getPgPool } from '../src/dbPg.ts';
import { structuredLog } from '../src/observability.ts';
import { runScheduledReconciliationPg } from '../src/services/scheduledReconciliationPg.ts';

const once = process.env.RECONCILE_ONCE === '1';
const intervalMs = Math.max(
  60_000,
  Number(process.env.RECONCILIATION_INTERVAL_MINUTES?.trim() || '15') * 60_000,
);

const jobTypes = [
  'wallet_ledger',
  'journal',
  'vouchers',
  'suspense',
  'fees',
  'commissions',
  'refunds',
  'settlement',
  'full',
];

async function tick() {
  const pool = getPgPool();
  for (const runType of jobTypes) {
    try {
      const result = await runScheduledReconciliationPg(pool, {
        runType,
        triggeredBy: `worker:${process.pid}`,
      });
      structuredLog(result.ok ? 'info' : 'error', 'reconciliation.worker', {
        ...result,
        runType,
        alert: !result.ok && !result.skipped,
      });
    } catch (error) {
      structuredLog('error', 'reconciliation.worker_failed', {
        runType,
        message: error instanceof Error ? error.message : 'failed',
        alert: true,
      });
    }
  }
}

await tick();
if (once) {
  await closePg();
  process.exit(process.exitCode ?? 0);
}

setInterval(() => {
  void tick();
}, intervalMs);

structuredLog('info', 'reconciliation.worker_started', {
  intervalMs,
  jobTypes,
});
