import 'dotenv/config';

import pg from 'pg';

const { Client } = pg;
const columns = [
  ['wallets', 'balance'],
  ['products', 'cost_price'], ['products', 'price'],
  ['transactions', 'amount'],
  ['ledger_entries', 'amount'], ['ledger_entries', 'balance_after'],
  ['sales', 'total'], ['expenses', 'amount'],
  ['credit_customers', 'total_owed'], ['credit_customers', 'credit_limit'],
  ['credit_transactions', 'amount'], ['supplier_orders', 'total'],
  ['stokvel_groups', 'target_amount'], ['stokvel_groups', 'current_amount'],
  ['stokvel_loans', 'amount'], ['stokvel_loans', 'interest_amount'],
  ['stokvel_loans', 'total_due'], ['stokvel_contributions', 'amount'],
  ['layby_orders', 'total_price'], ['layby_orders', 'amount_paid'],
  ['loans', 'amount'], ['loans', 'repaid_amount'],
  ['price_comparisons', 'my_price'], ['price_comparisons', 'avg_area_price'],
  ['price_comparisons', 'lowest_area_price'],
  ['price_comparisons', 'highest_area_price'],
  ['insurance_policies', 'coverage_amount'],
  ['insurance_policies', 'monthly_premium'],
  ['insurance_claims', 'claimed_amount'],
  ['cash_send_vouchers', 'amount'], ['cash_send_vouchers', 'fee'],
  ['stock_movements', 'cost_price_at_time'], ['purchase_slips', 'total'],
  ['commission_postings', 'amount'], ['utility_purchases', 'amount'],
];

function quote(identifier) {
  if (!/^[a-z_][a-z0-9_]*$/u.test(identifier)) {
    throw new Error(`Unsafe identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function config() {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('DATABASE_URL is required.');
  const hostname = new URL(connectionString).hostname;
  const local = ['localhost', '127.0.0.1', '::1'].includes(hostname);
  return {
    connectionString,
    ssl: local
      ? false
      : {
          rejectUnauthorized:
            process.env.PG_SSL_REJECT_UNAUTHORIZED?.toLowerCase() !== 'false',
        },
  };
}

const client = new Client(config());
await client.connect();
const report = {
  generatedAt: new Date().toISOString(),
  columns: [],
  exceptions: [],
  walletLedger: [],
  ok: true,
};

try {
  for (const [table, column] of columns) {
    const tableName = quote(table);
    const legacy = quote(column);
    const cents = quote(`${column}_cents`);
    const legacyExists = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = $1
            AND column_name = $2
       ) AS exists`,
      [table, column],
    );
    if (!legacyExists.rows[0]?.exists) {
      const summary = await client.query(`
        SELECT count(*)::text AS rows,
               count(${cents})::text AS populated,
               COALESCE(sum(${cents}), 0)::text AS cents_total
          FROM ${tableName}`);
      const row = summary.rows[0];
      const item = {
        table,
        column,
        contracted: true,
        rows: row.rows,
        populated: row.populated,
        centsTotal: row.cents_total,
        unsupportedPrecision: 0,
        mismatches: 0,
      };
      report.columns.push(item);
      continue;
    }
    const summary = await client.query(`
      SELECT count(*)::text AS rows,
             count(*) FILTER (WHERE ${legacy} IS NOT NULL)::text AS populated,
             COALESCE(sum(${cents}), 0)::text AS cents_total,
             count(*) FILTER (
               WHERE ${legacy} IS NOT NULL
                 AND (${legacy}::text IN ('NaN','Infinity','-Infinity')
                   OR trunc(${legacy}::numeric * 100) <> ${legacy}::numeric * 100)
             )::text AS unsupported_precision,
             count(*) FILTER (
               WHERE (${legacy} IS NULL) <> (${cents} IS NULL)
                  OR (${legacy} IS NOT NULL
                    AND ${legacy}::numeric * 100 <> ${cents}::numeric)
             )::text AS mismatches
        FROM ${tableName}`);
    const row = summary.rows[0];
    const item = {
      table,
      column,
      contracted: false,
      rows: row.rows,
      populated: row.populated,
      centsTotal: row.cents_total,
      unsupportedPrecision: Number(row.unsupported_precision),
      mismatches: Number(row.mismatches),
    };
    report.columns.push(item);
    if (item.unsupportedPrecision || item.mismatches) {
      report.ok = false;
      const exceptions = await client.query(`
        SELECT id::text,
               ${legacy}::text AS legacy_value,
               ${cents}::text AS cents_value
          FROM ${tableName}
         WHERE (${legacy} IS NULL) <> (${cents} IS NULL)
            OR (${legacy} IS NOT NULL AND (
              ${legacy}::text IN ('NaN','Infinity','-Infinity')
              OR trunc(${legacy}::numeric * 100) <> ${legacy}::numeric * 100
              OR ${legacy}::numeric * 100 <> ${cents}::numeric
            ))
         ORDER BY id
         LIMIT 100`);
      report.exceptions.push(
        ...exceptions.rows.map((exception) => ({ table, column, ...exception })),
      );
    }
  }

  const walletLedger = await client.query(`
    WITH ledger AS (
      SELECT account_id,
             COALESCE(sum(CASE entry_type
               WHEN 'credit' THEN amount_cents
               WHEN 'debit' THEN -amount_cents
               ELSE 0 END), 0)::bigint AS ledger_cents
        FROM ledger_entries
       GROUP BY account_id
    )
    SELECT w.id AS wallet_id,
           w.balance_cents::text,
           COALESCE(l.ledger_cents, 0)::text AS ledger_cents,
           (w.balance_cents - COALESCE(l.ledger_cents, 0))::text AS delta_cents
      FROM wallets w
      LEFT JOIN ledger l ON l.account_id = w.id
     WHERE w.balance_cents <> COALESCE(l.ledger_cents, 0)
     ORDER BY w.id`);
  report.walletLedger = walletLedger.rows;
  if (report.walletLedger.length) report.ok = false;
} finally {
  await client.end();
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Money reconciliation: ${report.ok ? 'PASS' : 'FAIL'}`);
  for (const row of report.columns) {
    console.log(
      `${row.table}.${row.column}: rows=${row.rows} cents_total=${row.centsTotal} ` +
        `precision_errors=${row.unsupportedPrecision} mismatches=${row.mismatches}`,
    );
  }
  console.log(`Exception rows: ${report.exceptions.length}`);
  console.log(`Wallet/ledger mismatches: ${report.walletLedger.length}`);
  console.log(JSON.stringify(report, null, 2));
}
if (!report.ok) process.exitCode = 2;
