import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const { processExpiredVouchersPg } = await import('../dist/services/voucherExpiryPg.js');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const result = await processExpiredVouchersPg(pool, Number(process.env.VOUCHER_EXPIRY_BATCH_SIZE ?? 100));
  console.log(JSON.stringify({ schemaVersion: 'phase5.v1', ranAt: new Date().toISOString(), ...result }));
} finally {
  await pool.end();
}
