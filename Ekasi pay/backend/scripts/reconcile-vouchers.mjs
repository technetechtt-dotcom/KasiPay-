import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

try {
  const result = await pool.query(`
    SELECT v.id, v.reference_number, v.status, v.amount_cents, v.fee_cents,
           v.hold_transaction_id, v.settlement_transaction_ids, v.refund_transaction_id,
           hold.amount_cents AS hold_cents,
           refund.amount_cents AS refund_cents,
           COALESCE((
             SELECT sum(t.amount_cents)
               FROM transactions t
              WHERE t.id IN (
                SELECT jsonb_array_elements_text(v.settlement_transaction_ids)
              )
           ), 0)::text AS settlement_cents
      FROM cash_send_vouchers v
      LEFT JOIN transactions hold ON hold.id = v.hold_transaction_id
      LEFT JOIN transactions refund ON refund.id = v.refund_transaction_id
  `);
  const discrepancies = result.rows.flatMap((row) => {
    const expected = BigInt(row.amount_cents) + BigInt(row.fee_cents);
    const issues = [];
    if (BigInt(row.hold_cents ?? -1) !== expected) issues.push('hold_mismatch');
    if (row.status === 'collected' && BigInt(row.settlement_cents) !== expected) issues.push('settlement_mismatch');
    if (['cancelled', 'expired'].includes(row.status) && BigInt(row.refund_cents ?? -1) !== expected) issues.push('refund_mismatch');
    return issues.length ? [{ voucherId: row.id, reference: row.reference_number, status: row.status, issues }] : [];
  });
  console.log(JSON.stringify({
    schemaVersion: 'phase5.v1',
    ranAt: new Date().toISOString(),
    vouchersChecked: result.rows.length,
    ok: discrepancies.length === 0,
    discrepancies,
  }));
  if (discrepancies.length) process.exitCode = 2;
} finally {
  await pool.end();
}
