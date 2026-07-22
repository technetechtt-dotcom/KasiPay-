import 'dotenv/config';

import pg from 'pg';

const { Client } = pg;
const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) throw new Error('DATABASE_URL is required.');
const url = new URL(connectionString);
const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
const client = new Client({
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
  const checks = await client.query(`
    WITH posted AS (
      SELECT t.id,
        COALESCE(sum(e.amount_cents) FILTER (WHERE e.side = 'debit'), 0) debit,
        COALESCE(sum(e.amount_cents) FILTER (WHERE e.side = 'credit'), 0) credit
      FROM journal_transactions t
      LEFT JOIN journal_entries e ON e.transaction_id = t.id
      WHERE t.state IN ('posted','settled','reversed')
      GROUP BY t.id
    ), derived AS (
      SELECT a.id,
        COALESCE(sum(CASE
          WHEN t.id IS NULL THEN 0
          WHEN e.side = 'credit' THEN e.amount_cents
          ELSE -e.amount_cents
        END), 0) cents
      FROM ledger_accounts a
      LEFT JOIN journal_entries e ON e.account_id = a.id
      LEFT JOIN journal_transactions t ON t.id = e.transaction_id
        AND t.state IN ('posted','settled','reversed')
      GROUP BY a.id
    )
    SELECT
      (SELECT count(*) FROM posted WHERE debit = 0 OR debit <> credit)::int unbalanced,
      (SELECT count(*) FROM derived d JOIN account_balance_projections p
        ON p.account_id = d.id WHERE d.cents <> p.available_cents
        AND NOT EXISTS (
          SELECT 1 FROM ledger_backfill_status b WHERE b.state = 'pending_signoff'
        ))::int projection_mismatches,
      (SELECT count(*) FROM account_balance_projections p
        JOIN ledger_accounts a ON a.id = p.account_id
        WHERE NOT a.allow_negative AND p.available_cents < 0)::int negative_balances,
      (SELECT legacy_transactions FROM ledger_backfill_status WHERE id = 1) legacy_transactions,
      (SELECT state FROM ledger_backfill_status WHERE id = 1) backfill_state
  `);
  const report = checks.rows[0];
  console.log(JSON.stringify(report, null, 2));
  if (
    report.unbalanced !== 0 ||
    report.projection_mismatches !== 0 ||
    report.negative_balances !== 0 ||
    report.backfill_state === 'pending_signoff'
  ) {
    process.exitCode = 2;
  }
} finally {
  await client.end();
}
