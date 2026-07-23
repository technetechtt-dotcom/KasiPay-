/**
 * Safe brownfield deploy migration sequence for Cash Send PII.
 *
 * 1. migrate:up through 010 (encrypt columns) — stops before 011 if plaintext remains
 * 2. optional backup hook (BACKUP_BEFORE_PII_DROP=1)
 * 3. cash-send:backfill-pii
 * 4. verify zero plaintext
 * 5. migrate:up for 011–012+
 *
 * Render: set preDeployCommand to `npm run migrate:deploy`
 */
import 'dotenv/config';

import { spawnSync } from 'node:child_process';
import pg from 'pg';

function run(script, args = [], { useTsx = false } = {}) {
  const nodeArgs = useTsx
    ? ['--import', 'tsx', script, ...args]
    : [script, ...args];
  const result = spawnSync(process.execPath, nodeArgs, {
    encoding: 'utf8',
    env: process.env,
    stdio: 'inherit',
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${script} ${args.join(' ')} failed with exit ${result.status}`);
  }
}

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) throw new Error('DATABASE_URL is required.');

const hostname = new URL(connectionString).hostname;
const local = ['localhost', '127.0.0.1', '::1'].includes(hostname);
const client = new pg.Client({
  connectionString,
  ssl: local
    ? false
    : {
        rejectUnauthorized:
          process.env.PG_SSL_REJECT_UNAUTHORIZED?.toLowerCase() !== 'false',
      },
});

async function plaintextCount() {
  const cols = await client.query(`
    SELECT
      to_regclass('public.cash_send_vouchers') IS NOT NULL AS table_exists,
      EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'cash_send_vouchers' AND column_name = 'sender_id_document'
      ) AS has_plaintext
  `);
  if (!cols.rows[0]?.table_exists || !cols.rows[0]?.has_plaintext) return 0;
  const count = await client.query(`
    SELECT count(*)::int AS n FROM cash_send_vouchers
     WHERE COALESCE(sender_id_document, '') <> ''
        OR COALESCE(recipient_id_document, '') <> ''
        OR COALESCE(sender_address, '') <> ''
        OR COALESCE(collector_scanned_id, '') <> ''
  `);
  return count.rows[0]?.n ?? 0;
}

async function appliedNames() {
  const exists = await client.query(
    `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS ok`,
  );
  if (!exists.rows[0]?.ok) return [];
  const rows = await client.query(`SELECT name FROM schema_migrations ORDER BY name`);
  return rows.rows.map((r) => r.name);
}

await client.connect();
try {
  console.log('[migrate:deploy] Applying migrations (may stop before 011 if plaintext remains)…');
  // First pass: apply everything possible. If 011 refuses, we catch via second strategy.
  let first = spawnSync(process.execPath, ['scripts/migrate.mjs', 'up'], {
    encoding: 'utf8',
    env: process.env,
  });
  if ((first.status ?? 1) !== 0) {
    const combined = `${first.stdout ?? ''}\n${first.stderr ?? ''}`;
    if (!/cash_send plaintext PII still present/i.test(combined)) {
      process.stdout.write(first.stdout ?? '');
      process.stderr.write(first.stderr ?? '');
      throw new Error('migrate:up failed before PII backfill gate.');
    }
    console.warn(
      '[migrate:deploy] Migration 011 refused leftover plaintext — continuing with backfill sequence.',
    );
  } else {
    process.stdout.write(first.stdout ?? '');
  }

  const names = await appliedNames();
  const has010 = names.some((n) => n.includes('010_encrypt_cash_send_pii'));
  const has011 = names.some((n) => n.includes('011_drop_cash_send_plaintext_pii'));
  const leftover = await plaintextCount();

  if (has010 && !has011) {
    if (process.env.BACKUP_BEFORE_PII_DROP === '1') {
      console.log('[migrate:deploy] BACKUP_BEFORE_PII_DROP=1 — running backup:postgres…');
      run('scripts/backup-postgres.mjs');
    }
    if (leftover > 0) {
      console.log(`[migrate:deploy] Backfilling ${leftover} plaintext Cash Send row(s)…`);
      run('scripts/backfill-cash-send-pii.mjs', [], { useTsx: true });
    }
    const afterBackfill = await plaintextCount();
    if (afterBackfill > 0) {
      throw new Error(
        `PII backfill left ${afterBackfill} plaintext row(s); refusing to apply 011.`,
      );
    }
    console.log('[migrate:deploy] Zero plaintext confirmed — applying remaining migrations…');
    run('scripts/migrate.mjs', ['up']);
  } else if (!has011 && leftover > 0) {
    throw new Error(
      'Plaintext Cash Send PII exists but migration 010 is not applied; run migrate:up manually.',
    );
  } else {
    console.log('[migrate:deploy] PII drop already applied or no plaintext gate required.');
  }

  const finalLeftover = await plaintextCount();
  if (finalLeftover > 0) {
    throw new Error(`Deploy verification failed: ${finalLeftover} plaintext PII row(s) remain.`);
  }
  const finalNames = await appliedNames();
  const dropped = finalNames.some((n) => n.includes('011_drop_cash_send_plaintext_pii'));
  const cols = await client.query(`
    SELECT column_name FROM information_schema.columns
     WHERE table_name = 'cash_send_vouchers'
       AND column_name IN (
         'sender_id_document','recipient_id_document','sender_address','collector_scanned_id'
       )
  `);
  if (dropped && cols.rowCount > 0) {
    throw new Error('Migration 011 recorded but plaintext columns still exist.');
  }
  console.log(
    JSON.stringify({
      ok: true,
      migration011Applied: dropped,
      plaintextColumnsRemaining: cols.rowCount,
      applied: finalNames.slice(-5),
    }),
  );
} finally {
  await client.end();
}
