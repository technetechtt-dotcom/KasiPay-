/**
 * Dev-only: credit a user wallet balance for field testing.
 *
 * Usage (SQLite — default):
 *   cd backend
 *   node scripts/credit-wallet.mjs 1000000 0821234567
 *
 * Credit every active user wallet (local testing):
 *   CREDIT_ALL_WALLETS=1 node scripts/credit-wallet.mjs 1000000
 *
 * Postgres:
 *   DATABASE_URL=postgresql://... node scripts/credit-wallet.mjs 1000000 0821234567
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const amount = Number(process.argv[2] ?? process.env.CREDIT_AMOUNT ?? 1_000_000);
const phoneArg = (process.argv[3] ?? process.env.CREDIT_PHONE ?? '').replace(/\D/g, '');
const creditAll = process.env.CREDIT_ALL_WALLETS === '1';

if (!Number.isFinite(amount) || amount <= 0) {
  console.error('Amount must be a positive number.');
  process.exit(1);
}

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to run credit-wallet in production.');
  process.exit(1);
}

const DATABASE_PATH =
  process.env.DATABASE_PATH ??
  path.resolve(__dirname, '..', 'data', 'ekasi-pay.db');
const DATABASE_URL = process.env.DATABASE_URL?.trim() ?? '';

async function creditSqlite() {
  const db = new Database(DATABASE_PATH);
  db.pragma('foreign_keys = ON');

  const targets = phoneArg
    ? db
        .prepare(
          `SELECT w.id, w.user_id, w.balance, u.phone, u.name
             FROM wallets w
             JOIN users u ON u.id = w.user_id
            WHERE u.phone = ?
              AND COALESCE(w.wallet_kind, 'user') = 'user'
              AND w.status = 'active'
              AND u.deleted_at IS NULL`,
        )
        .all(phoneArg)
    : creditAll
      ? db
          .prepare(
            `SELECT w.id, w.user_id, w.balance, u.phone, u.name
               FROM wallets w
               JOIN users u ON u.id = w.user_id
              WHERE COALESCE(w.wallet_kind, 'user') = 'user'
                AND w.status = 'active'
                AND u.deleted_at IS NULL`,
          )
          .all()
      : db
          .prepare(
            `SELECT w.id, w.user_id, w.balance, u.phone, u.name
               FROM wallets w
               JOIN users u ON u.id = w.user_id
              WHERE COALESCE(w.wallet_kind, 'user') = 'user'
                AND w.status = 'active'
                AND u.deleted_at IS NULL
              ORDER BY datetime(u.created_at) DESC
              LIMIT 1`,
          )
          .all();

  if (targets.length === 0) {
    db.close();
    throw new Error(
      phoneArg
        ? `No active wallet for phone ${phoneArg}.`
        : 'No active user wallets found. Register/sign in first.',
    );
  }

  const now = new Date().toISOString();
  for (const row of targets) {
    const next = row.balance + amount;
    db.prepare(`UPDATE wallets SET balance = ? WHERE id = ?`).run(next, row.id);
    const txId = randomUUID();
    db.prepare(
      `INSERT INTO transactions (
         id, from_wallet_id, to_wallet_id, amount, type, status, reference, description, created_at
       ) VALUES (?, NULL, ?, ?, 'dev_credit', 'completed', ?, ?, ?)`,
    ).run(
      txId,
      row.id,
      amount,
      `DEV${Date.now()}`,
      `Dev test credit R${amount.toFixed(2)}`,
      now,
    );
    console.log(
      `  ✓ ${row.name} (${row.phone}): R${row.balance.toFixed(2)} → R${next.toFixed(2)}`,
    );
  }
  db.close();
}

async function creditPostgres() {
  const pool = new pg.Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  try {
    const params = [];
    let where = `COALESCE(w.wallet_kind, 'user') = 'user'
                 AND w.status = 'active'
                 AND u.deleted_at IS NULL`;
    if (phoneArg) {
      params.push(phoneArg);
      where += ` AND u.phone = $${params.length}`;
    }
    const limit = phoneArg || creditAll ? '' : 'LIMIT 1';
    const r = await pool.query(
      `SELECT w.id, w.user_id, w.balance, u.phone, u.name
         FROM wallets w
         JOIN users u ON u.id = w.user_id
        WHERE ${where}
        ORDER BY u.created_at DESC
        ${limit}`,
      params,
    );
    if (r.rows.length === 0) {
      throw new Error(
        phoneArg
          ? `No active wallet for phone ${phoneArg}.`
          : 'No active user wallets found.',
      );
    }
    const now = new Date().toISOString();
    for (const row of r.rows) {
      const next = Number(row.balance) + amount;
      await pool.query(`UPDATE wallets SET balance = $1 WHERE id = $2`, [next, row.id]);
      const txId = randomUUID();
      await pool.query(
        `INSERT INTO transactions (
           id, from_wallet_id, to_wallet_id, amount, type, status, reference, description, created_at
         ) VALUES ($1, NULL, $2, $3, 'dev_credit', 'completed', $4, $5, $6)`,
        [
          txId,
          row.id,
          amount,
          `DEV${Date.now()}`,
          `Dev test credit R${amount.toFixed(2)}`,
          now,
        ],
      );
      console.log(
        `  ✓ ${row.name} (${row.phone}): R${Number(row.balance).toFixed(2)} → R${next.toFixed(2)}`,
      );
    }
  } finally {
    await pool.end();
  }
}

async function main() {
  console.log(`Crediting R${amount.toLocaleString('en-ZA')}…`);
  if (DATABASE_URL) {
    await creditPostgres();
  } else {
    await creditSqlite();
  }
  console.log('Done. Refresh the app to see the new balance.');
}

main().catch((err) => {
  console.error('credit-wallet failed:', err.message);
  process.exit(1);
});
