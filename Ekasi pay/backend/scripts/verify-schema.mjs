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
  'payout_agents',
];

const paymentArchitecture = [
  'bank_accounts',
  'safeguarding_accounts',
  'merchant_float_topups',
  'merchant_cash_availability',
  'payment_intents',
];

const cashLiquidity = [
  'merchant_cash_liquidity',
  'merchant_cash_reservations',
  'cash_send_payout_otps',
  'reconciliation_worker_heartbeats',
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
  const allExpected = [...required, ...paymentArchitecture, ...cashLiquidity];
  const have = await client.query(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
    [allExpected],
  );
  const names = new Set(have.rows.map((row) => row.tablename));
  const missing = required.filter((name) => !names.has(name));
  const missing022 = paymentArchitecture.filter((name) => !names.has(name));
  const missing023 = cashLiquidity.filter((name) => !names.has(name));
  const applied = await client.query(
    `SELECT name FROM schema_migrations ORDER BY name`,
  );
  const appliedNames = new Set(applied.rows.map((row) => row.name));
  const { createHash } = await import('node:crypto');
  const fingerprint = createHash('sha256')
    .update(applied.rows.map((row) => row.name).join(','))
    .digest('hex')
    .slice(0, 16);
  console.log(`host=${hostname}`);
  console.log(`public_tables=${tables.rows[0].n}`);
  console.log(`schema_migrations=${applied.rows.length}`);
  console.log(`schema_fingerprint=${fingerprint}`);
  console.log(`migration_021=${appliedNames.has('021_merchant_map_pins') ? 'applied' : 'missing'}`);
  console.log(`migration_022=${appliedNames.has('022_payment_architecture') ? 'applied' : 'missing'}`);
  console.log(`migration_023=${appliedNames.has('023_client_funds_cash_liquidity') ? 'applied' : 'missing'}`);
  console.log(`missing=${missing.join(',') || 'none'}`);
  console.log(`missing_022_tables=${missing022.join(',') || 'none'}`);
  console.log(`missing_023_tables=${missing023.join(',') || 'none'}`);
  if (missing.length > 0) process.exitCode = 1;
} finally {
  await client.end();
}
