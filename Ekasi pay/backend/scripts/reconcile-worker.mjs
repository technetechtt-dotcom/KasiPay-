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
import {
  claimQueuedReconciliationJobsPg,
  runScheduledReconciliationPg,
} from '../src/services/scheduledReconciliationPg.ts';

const once = process.env.RECONCILE_ONCE === '1';
const intervalMs = Math.max(
  60_000,
  Number(process.env.RECONCILIATION_INTERVAL_MINUTES?.trim() || '15') * 60_000,
);
const workerId = `worker:${process.pid}`;

const jobTypes = [
  'wallet_ledger',
  'journal',
  'projection',
  'vouchers',
  'fees',
  'commissions',
  'refunds',
  'settlement',
  'provider_instructions',
  'suspense',
  'loans',
  'insurance',
  'full',
];

async function processQueue() {
  const pool = getPgPool();
  const claimed = await claimQueuedReconciliationJobsPg(pool, workerId, 10);
  for (const job of claimed) {
    try {
      const result = await runScheduledReconciliationPg(pool, {
        runType: job.runType,
        triggeredBy: `${workerId}:queue`,
      });
      await pool.query(
        `UPDATE reconciliation_job_requests
            SET state = $2, completed_at = clock_timestamp(), run_id = NULLIF($3,'')::uuid,
                error_message = NULL
          WHERE id = $1`,
        [job.id, result.ok ? 'completed' : 'failed', result.runId || null],
      );
      structuredLog(result.ok ? 'info' : 'error', 'reconciliation.queue_job', {
        ...result,
        requestId: job.id,
        runType: job.runType,
        alert: !result.ok && !result.skipped,
        pageOnCall: !result.ok && !result.skipped,
      });
    } catch (error) {
      await pool.query(
        `UPDATE reconciliation_job_requests
            SET state = 'failed', completed_at = clock_timestamp(),
                error_message = $2
          WHERE id = $1`,
        [job.id, error instanceof Error ? error.message : 'failed'],
      );
      structuredLog('error', 'reconciliation.queue_job_failed', {
        requestId: job.id,
        runType: job.runType,
        message: error instanceof Error ? error.message : 'failed',
        alert: true,
        pageOnCall: true,
      });
    }
  }
}

async function tick() {
  const pool = getPgPool();
  await processQueue();
  for (const runType of jobTypes) {
    try {
      const result = await runScheduledReconciliationPg(pool, {
        runType,
        triggeredBy: workerId,
      });
      structuredLog(result.ok ? 'info' : 'error', 'reconciliation.worker', {
        ...result,
        runType,
        alert: !result.ok && !result.skipped,
        pageOnCall: !result.ok && !result.skipped,
      });
    } catch (error) {
      structuredLog('error', 'reconciliation.worker_failed', {
        runType,
        message: error instanceof Error ? error.message : 'failed',
        alert: true,
        pageOnCall: true,
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
