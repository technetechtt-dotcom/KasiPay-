import { createHash, randomUUID } from 'node:crypto';

import 'dotenv/config';
import pg from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required. Use an isolated clone, never live production.');
}
if (process.env.NODE_ENV === 'production') {
  throw new Error('Legacy Stokvel inventory is intentionally disabled in production.');
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]),
    );
  }
  return value;
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

try {
  const groups = await pool.query(
    `SELECT id,merchant_id,name,members_json,target_amount_cents,current_amount_cents,
            frequency,next_payout_date,created_at
       FROM stokvel_groups ORDER BY id`,
  );
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const row of groups.rows) {
      const [loans, contributions] = await Promise.all([
        client.query(`SELECT * FROM stokvel_loans WHERE stokvel_id = $1 ORDER BY created_at,id`, [row.id]),
        client.query(`SELECT * FROM stokvel_contributions WHERE stokvel_id = $1 ORDER BY created_at,id`, [row.id]),
      ]);
      const snapshot = {
        group: row,
        loans: loans.rows,
        contributions: contributions.rows,
      };
      await client.query(
        `INSERT INTO stokvel_legacy_conversion
           (id,legacy_group_id,legacy_snapshot,snapshot_sha256,expected_cents,state)
         VALUES ($1,$2,$3,$4,$5,'inventoried')
         ON CONFLICT (legacy_group_id) DO NOTHING`,
        [randomUUID(), row.id, snapshot, digest(snapshot), row.current_amount_cents],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  console.info(`Inventoried ${groups.rowCount ?? 0} legacy Stokvel groups; no balances were moved.`);
} finally {
  await pool.end();
}
