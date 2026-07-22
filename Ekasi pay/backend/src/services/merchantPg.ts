import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

export async function getMerchantByUserIdPg(
  pool: Pool,
  userId: string,
): Promise<{ id: string; user_id: string } | undefined> {
  const r = await pool.query<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM merchants WHERE user_id = $1`,
    [userId],
  );
  return r.rows[0];
}

export async function requireMerchantIdPg(
  pool: Pool,
  userId: string,
): Promise<string> {
  const row = await getMerchantByUserIdPg(pool, userId);
  if (!row) {
    throw Object.assign(new Error('Merchant profile required'), { status: 403 });
  }
  return row.id;
}

export async function ensureMerchantIdPg(
  pool: Pool,
  userId: string,
): Promise<string> {
  const existing = await getMerchantByUserIdPg(pool, userId);
  if (existing) return existing.id;

  const user = await pool.query<{ name: string }>(
    `SELECT name FROM users WHERE id = $1`,
    [userId],
  );
  const row = user.rows[0];
  if (!row) {
    throw Object.assign(new Error('User not found'), { status: 404 });
  }

  const id = randomUUID();
  await pool.query(
    `INSERT INTO merchants (
       id, user_id, business_name, location, category, approval_status
     ) VALUES ($1, $2, $3, $4, $5, 'pending_docs')`,
    [id, userId, `${row.name}'s Shop`, 'South Africa', 'Retail'],
  );
  return id;
}
