import { spawn } from 'node:child_process';
import pg from 'pg';

/**
 * Isolated restore drill.
 *
 * Modes:
 * - pg_restore (default): requires RESTORE_DATABASE_URL + RESTORE_DUMP_FILE
 * - neon_branch: validates a Neon branch fork (RESTORE_MODE=neon_branch,
 *   RESTORE_NEON_BRANCH_ID, RESTORE_DATABASE_URL pointing at the branch)
 */
if (process.env.DRILL_ENVIRONMENT !== 'isolated') {
  throw new Error('DRILL_ENVIRONMENT=isolated is mandatory.');
}
if (process.env.NODE_ENV === 'production' || /prod/i.test(process.env.RESTORE_DATABASE_URL ?? '')) {
  throw new Error('Restore drills may never target production.');
}

const mode = (process.env.RESTORE_MODE ?? 'pg_restore').trim().toLowerCase();
const startedAt = new Date().toISOString();

async function assertRestoredDatabase(connectionString) {
  const client = new pg.Client({
    connectionString,
    ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED?.toLowerCase() !== 'false' },
  });
  await client.connect();
  try {
    const migrations = await client.query(
      `SELECT count(*)::int AS n FROM schema_migrations`,
    ).catch(() => ({ rows: [{ n: 0 }] }));
    const wallets = await client.query(
      `SELECT count(*)::int AS n FROM wallets`,
    ).catch(() => ({ rows: [{ n: -1 }] }));
    const journals = await client.query(
      `SELECT count(*)::int AS n FROM journal_transactions`,
    ).catch(() => ({ rows: [{ n: -1 }] }));
    return {
      migrationCount: migrations.rows[0]?.n ?? 0,
      walletCount: wallets.rows[0]?.n ?? -1,
      journalCount: journals.rows[0]?.n ?? -1,
    };
  } finally {
    await client.end();
  }
}

if (mode === 'neon_branch') {
  const branchId = process.env.RESTORE_NEON_BRANCH_ID?.trim();
  const url = process.env.RESTORE_DATABASE_URL?.trim();
  if (!branchId) throw new Error('RESTORE_NEON_BRANCH_ID is required for neon_branch mode.');
  if (!url) throw new Error('RESTORE_DATABASE_URL (branch connection) is required for neon_branch mode.');
  const counts = await assertRestoredDatabase(url);
  const passed =
    counts.migrationCount > 0 && counts.walletCount >= 0 && counts.journalCount >= 0;
  const result = {
    schemaVersion: 'phase5.drill.v2',
    drillType: 'restore_reconcile',
    environment: 'isolated',
    mode: 'neon_branch',
    startedAt,
    completedAt: new Date().toISOString(),
    outcome: passed ? 'passed' : 'failed',
    assertions: [
      {
        name: 'neon_branch_fork_recorded',
        passed: true,
        detail: `Branch ${branchId}`,
      },
      {
        name: 'schema_migrations_present',
        passed: counts.migrationCount > 0,
        detail: `migrations=${counts.migrationCount}`,
      },
      {
        name: 'wallet_and_journal_readable',
        passed: counts.walletCount >= 0 && counts.journalCount >= 0,
        detail: `wallets=${counts.walletCount} journals=${counts.journalCount}`,
      },
    ],
    evidenceRefs: [branchId, counts],
    runnerVersion: 'phase5-v3',
  };
  console.log(JSON.stringify(result));
  process.exit(passed ? 0 : 1);
}

const url = process.env.RESTORE_DATABASE_URL;
const dump = process.env.RESTORE_DUMP_FILE;
if (!url || !dump) throw new Error('RESTORE_DATABASE_URL and RESTORE_DUMP_FILE are required.');

const code = await new Promise((resolve, reject) => {
  const child = spawn('pg_restore', ['--clean', '--if-exists', '--no-owner', '--dbname', url, dump], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  child.once('error', reject);
  child.once('exit', resolve);
});

let counts = { migrationCount: 0, walletCount: -1, journalCount: -1 };
if (code === 0) {
  counts = await assertRestoredDatabase(url);
}

const passed =
  code === 0 &&
  counts.migrationCount > 0 &&
  counts.walletCount >= 0 &&
  counts.journalCount >= 0;

const result = {
  schemaVersion: 'phase5.drill.v2',
  drillType: 'restore_reconcile',
  environment: 'isolated',
  mode: 'pg_restore',
  startedAt,
  completedAt: new Date().toISOString(),
  outcome: passed ? 'passed' : 'failed',
  assertions: [
    { name: 'pg_restore_completed', passed: code === 0 },
    {
      name: 'schema_migrations_present',
      passed: counts.migrationCount > 0,
      detail: `migrations=${counts.migrationCount}`,
    },
    {
      name: 'wallet_and_journal_readable',
      passed: counts.walletCount >= 0 && counts.journalCount >= 0,
      detail: `wallets=${counts.walletCount} journals=${counts.journalCount}`,
    },
  ],
  evidenceRefs: [counts],
  runnerVersion: 'phase5-v3',
};
console.log(JSON.stringify(result));
if (!passed) process.exitCode = Number(code) || 1;
