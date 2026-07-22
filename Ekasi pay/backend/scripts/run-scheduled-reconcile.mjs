/**
 * One-shot scheduled reconciliation entrypoint (cron / ops).
 *   DATABASE_URL=... npm run reconcile:scheduled
 */
import 'dotenv/config';

import { closePg, getPgPool } from '../src/dbPg.ts';
import { runScheduledReconciliationPg } from '../src/services/scheduledReconciliationPg.ts';

const pool = getPgPool();
try {
  const result = await runScheduledReconciliationPg(pool, {
    runType: 'full',
    triggeredBy: process.env.RECONCILE_TRIGGERED_BY?.trim() || 'cli',
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 2;
} finally {
  await closePg();
}
