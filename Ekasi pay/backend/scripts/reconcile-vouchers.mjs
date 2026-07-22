import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

try {
  const result = await pool.query(`
    WITH journal_totals AS (
      SELECT t.id,
             COALESCE(sum(e.amount_cents) FILTER (WHERE e.side = 'debit'), 0) AS debit_cents
        FROM journal_transactions t
        LEFT JOIN journal_entries e ON e.transaction_id = t.id
       GROUP BY t.id
    )
    SELECT v.id, v.reference_number, v.status, v.amount_cents, v.fee_cents,
           v.hold_transaction_id, v.settlement_transaction_ids, v.refund_transaction_id,
           hold.debit_cents AS hold_cents,
           refund.debit_cents AS refund_cents,
           COALESCE((
             SELECT sum(j.debit_cents)
               FROM journal_totals j
              WHERE j.id::text IN (
                SELECT jsonb_array_elements_text(v.settlement_transaction_ids)
              )
           ), 0)::text AS settlement_cents
      FROM cash_send_vouchers v
      LEFT JOIN journal_totals hold ON hold.id = v.hold_transaction_id
      LEFT JOIN journal_totals refund ON refund.id = v.refund_transaction_id
  `);
  const discrepancies = result.rows.flatMap((row) => {
    const expected = BigInt(row.amount_cents) + BigInt(row.fee_cents);
    const issues = [];
    // Legacy vouchers created before journal holds may have null hold ids.
    if (row.hold_transaction_id != null && BigInt(row.hold_cents ?? -1) !== expected) {
      issues.push('hold_mismatch');
    }
    if (row.status === 'collected' && BigInt(row.settlement_cents) !== expected) {
      issues.push('settlement_mismatch');
    }
    if (
      ['cancelled', 'expired'].includes(row.status) &&
      row.refund_transaction_id != null &&
      BigInt(row.refund_cents ?? -1) !== expected
    ) {
      issues.push('refund_mismatch');
    }
    return issues.length
      ? [{ voucherId: row.id, reference: row.reference_number, status: row.status, issues }]
      : [];
  });
  console.log(JSON.stringify({
    schemaVersion: 'phase5.v2',
    ranAt: new Date().toISOString(),
    vouchersChecked: result.rows.length,
    ok: discrepancies.length === 0,
    discrepancies,
  }));
  if (discrepancies.length) process.exitCode = 2;
} finally {
  await pool.end();
}
