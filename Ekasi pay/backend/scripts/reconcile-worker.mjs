/**
 * Dedicated reconciliation worker (cron / long-running).
 * Do not run full reconciliation inside the API process.
 *
 *   DATABASE_URL=... npm run reconcile:worker
 *   RECONCILE_ONCE=1 DATABASE_URL=... npm run reconcile:worker
 */
import 'dotenv/config';

import { closePg, getPgPool } from '../src/dbPg.ts';
import { isNonFundsDeployment } from '../src/deploymentMode.ts';
import { structuredLog } from '../src/observability.ts';
import { schemaFingerprintPg } from '../src/services/schemaFingerprintPg.ts';
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
const nonFunds = isNonFundsDeployment(process.env);

const moneyJobTypes = [
  'vouchers',
  'fees',
  'commissions',
  'refunds',
  'settlement',
  'provider_instructions',
  'suspense',
  'loans',
  'insurance',
];

const jobTypes = nonFunds
  ? ['wallet_ledger', 'journal', 'projection']
  : [
      'wallet_ledger',
      'journal',
      'projection',
      ...moneyJobTypes,
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
        alert: !result.ok && !result.skipped && !nonFunds,
        pageOnCall: !result.ok && !result.skipped && !nonFunds,
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
        alert: !nonFunds,
        pageOnCall: !nonFunds,
      });
    }
  }
}

async function beat() {
  const pool = getPgPool();
  const fingerprint = await schemaFingerprintPg(pool).catch(() => ({
    schemaMigrations: 0,
    schemaFingerprint: '',
  }));
  await pool.query(
    `INSERT INTO reconciliation_worker_heartbeats
       (worker_id, schema_fingerprint, schema_migrations, last_seen_at, last_ok_at, worker_version)
     VALUES ($1,$2,$3,clock_timestamp(),clock_timestamp(),$4)
     ON CONFLICT (worker_id)
     DO UPDATE SET schema_fingerprint = EXCLUDED.schema_fingerprint,
                   schema_migrations = EXCLUDED.schema_migrations,
                   last_seen_at = clock_timestamp(),
                   last_ok_at = clock_timestamp(),
                   worker_version = EXCLUDED.worker_version`,
    [
      workerId,
      fingerprint.schemaFingerprint,
      fingerprint.schemaMigrations,
      process.env.RENDER_GIT_COMMIT?.slice(0, 12) || process.env.npm_package_version || '0.1.0',
    ],
  );
  return fingerprint;
}

async function tick() {
  const pool = getPgPool();
  const fingerprint = await beat().catch((error) => {
    structuredLog('error', 'reconciliation.worker_heartbeat_failed', {
      message: error instanceof Error ? error.message : 'failed',
    });
    return null;
  });
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
        schemaFingerprint: fingerprint?.schemaFingerprint,
        alert: !result.ok && !result.skipped && !nonFunds,
        pageOnCall: !result.ok && !result.skipped && !nonFunds,
      });
    } catch (error) {
      structuredLog('error', 'reconciliation.worker_failed', {
        runType,
        message: error instanceof Error ? error.message : 'failed',
        alert: !nonFunds,
        pageOnCall: !nonFunds,
      });
    }
  }
}

async function safeTick() {
  try {
    await tick();
  } catch (error) {
    structuredLog('error', 'reconciliation.worker_tick_failed', {
      message: error instanceof Error ? error.message : 'failed',
      alert: !nonFunds,
      pageOnCall: !nonFunds,
    });
  }
}

if (!process.env.DATABASE_URL?.trim()) {
  structuredLog('error', 'reconciliation.worker_missing_database', {
    message: 'DATABASE_URL is required. Set the same Neon URL as ekasi-pay-api.',
    alert: true,
  });
  process.exit(1);
}

structuredLog('info', 'reconciliation.worker_started', {
  intervalMs,
  jobTypes,
  nonFunds,
});

await safeTick();
if (once) {
  await closePg();
  process.exit(process.exitCode ?? 0);
}

setInterval(() => {
  void safeTick();
}, intervalMs);
