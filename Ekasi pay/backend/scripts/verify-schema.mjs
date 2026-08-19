/**
 * Verify required public tables without printing DATABASE_URL.
 * Usage: node scripts/verify-schema.mjs
 */
import 'dotenv/config';

import pg from 'pg';

const required = [
  'schema_migrations',
  'users',
  'wallets',
  'ledger_entries',
  'reconciliation_job_leases',
  'reconciliation_runs',
  'approval_requests',
  'operational_controls',
  'merchant_activations',
  'fee_schedules',
];

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}

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

await client.connect();
try {
  const tables = await client.query(
    `SELECT count(*)::int AS n
       FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  );
  const have = await client.query(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
    [required],
  );
  const names = new Set(have.rows.map((row) => row.tablename));
  const missing = required.filter((name) => !names.has(name));
  const applied = await client.query(
    `SELECT count(*)::int AS n FROM schema_migrations`,
  );
  console.log(`host=${hostname}`);
  console.log(`public_tables=${tables.rows[0].n}`);
  console.log(`schema_migrations=${applied.rows[0].n}`);
  console.log(`missing=${missing.join(',') || 'none'}`);
  if (missing.length > 0) process.exitCode = 1;
} finally {
  await client.end();
}
