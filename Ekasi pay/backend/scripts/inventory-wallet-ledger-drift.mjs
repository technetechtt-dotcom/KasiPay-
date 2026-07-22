/**
 * Inventory wallet ↔ legacy ledger_entries drift for finance sign-off.
 * Read-only. Does not mutate balances.
 *
 *   DATABASE_URL=... npm run money:drift-inventory
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

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

await client.connect();
try {
  const wallets = await client.query(`
    WITH ledger AS (
      SELECT account_id,
             COALESCE(sum(CASE entry_type
               WHEN 'credit' THEN amount_cents
               WHEN 'debit' THEN -amount_cents
               ELSE 0 END), 0)::bigint AS ledger_cents,
             count(*)::int AS entry_count
        FROM ledger_entries
       GROUP BY account_id
    )
    SELECT w.id AS wallet_id,
           w.user_id,
           COALESCE(w.wallet_kind, 'user') AS wallet_kind,
           w.balance_cents::text AS balance_cents,
           COALESCE(l.ledger_cents, 0)::text AS legacy_ledger_cents,
           (w.balance_cents - COALESCE(l.ledger_cents, 0))::text AS delta_cents,
           COALESCE(l.entry_count, 0)::int AS legacy_entry_count
      FROM wallets w
      LEFT JOIN ledger l ON l.account_id = w.id
     ORDER BY abs(w.balance_cents - COALESCE(l.ledger_cents, 0)) DESC, w.id
  `);

  const drifted = wallets.rows.filter((row) => row.delta_cents !== '0');
  const backfill = await client.query(
    `SELECT to_regclass('public.ledger_backfill_status') IS NOT NULL AS exists`,
  );
  let backfillStatus = null;
  if (backfill.rows[0]?.exists) {
    const status = await client.query(
      `SELECT state, legacy_transactions::text, checked_at, completed_at
         FROM ledger_backfill_status WHERE id = 1`,
    );
    backfillStatus = status.rows[0] ?? null;
  }

  const journalExists = await client.query(
    `SELECT to_regclass('public.journal_transactions') IS NOT NULL AS exists`,
  );
  let journalCount = null;
  if (journalExists.rows[0]?.exists) {
    const count = await client.query(`SELECT count(*)::int AS count FROM journal_transactions`);
    journalCount = count.rows[0]?.count ?? 0;
  }

  const report = {
    schemaVersion: 'phase3.wallet_ledger_drift.v1',
    generatedAt: new Date().toISOString(),
    purpose: 'Finance sign-off input before ledger:backfill / money contract on production',
    totals: {
      wallets: wallets.rows.length,
      driftedWallets: drifted.length,
      driftedAbsCents: drifted
        .reduce((sum, row) => {
          const delta = BigInt(row.delta_cents);
          return sum + (delta < 0n ? -delta : delta);
        }, 0n)
        .toString(),
      journalTransactions: journalCount,
    },
    backfillStatus,
    drifted,
    balancedSample: wallets.rows.filter((row) => row.delta_cents === '0').slice(0, 20),
    nextSteps: [
      'Do not enable regulated products while driftedWallets > 0 without written finance approval.',
      'If journal is empty and backfill_status=pending_signoff, schedule ALLOW_LEDGER_BACKFILL=1 after approval.',
      'Retain this artifact URI in evidence/production-readiness.json under accounting.',
    ],
    ok: drifted.length === 0,
  };

  const outDir = path.resolve('artifacts');
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `wallet-ledger-drift-${Date.now()}.json`);
  writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, evidenceFile: outFile }, null, 2));
  if (!report.ok) process.exitCode = 2;
} finally {
  await client.end();
}
