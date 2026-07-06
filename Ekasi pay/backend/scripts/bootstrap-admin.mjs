/**
 * Create the first admin user directly in SQLite (registration API excludes admin).
 *
 * Usage:
 *   cd backend && node scripts/bootstrap-admin.mjs
 *
 * Env (optional):
 *   ADMIN_BOOTSTRAP_PHONE=0780000001
 *   ADMIN_BOOTSTRAP_PIN=4321
 *   ADMIN_BOOTSTRAP_NAME=Ekasi Admin
 *   DATABASE_PATH=./data/ekasi-pay.db
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const DATABASE_PATH =
  process.env.DATABASE_PATH ??
  path.resolve(__dirname, '..', 'data', 'ekasi-pay.db');
const phone = (process.env.ADMIN_BOOTSTRAP_PHONE ?? '0780000001').replace(/\D/g, '');
const pin = process.env.ADMIN_BOOTSTRAP_PIN ?? '4321';
const name = process.env.ADMIN_BOOTSTRAP_NAME ?? 'Ekasi Admin';

function hashPin(value) {
  const rounds = Number(process.env.BCRYPT_ROUNDS);
  const cost =
    Number.isFinite(rounds) && rounds >= 8 && rounds <= 14 ? Math.floor(rounds) : 12;
  return bcrypt.hashSync(value, bcrypt.genSaltSync(cost));
}

export async function bootstrapAdmin() {
  const db = new Database(DATABASE_PATH);
  db.pragma('foreign_keys = ON');

  const existingAdmin = db
    .prepare(
      `SELECT id, phone FROM users WHERE role = 'admin' AND deleted_at IS NULL LIMIT 1`,
    )
    .get();
  if (existingAdmin) {
    console.log(`  ✓ admin already exists → ${existingAdmin.phone}`);
    db.close();
    return existingAdmin;
  }

  const phoneTaken = db
    .prepare(`SELECT id FROM users WHERE phone = ? AND deleted_at IS NULL`)
    .get(phone);
  if (phoneTaken) {
    db.close();
    throw new Error(
      `Phone ${phone} is already registered. Set ADMIN_BOOTSTRAP_PHONE to a free number.`,
    );
  }

  const userId = randomUUID();
  const walletId = randomUUID();
  const now = new Date().toISOString();
  const pinHash = hashPin(pin);

  db.transaction(() => {
    db.prepare(
      `INSERT INTO users (
          id, name, phone, pin_hash, role, kyc_status, account_tier, created_at,
          country_code, is_system
        ) VALUES (?, ?, ?, ?, 'admin', 'verified', 'Premium', ?, 'ZA', 0)`,
    ).run(userId, name, phone, pinHash, now);
    db.prepare(
      `INSERT INTO wallets (id, user_id, balance, currency, status, pool_id, wallet_kind)
       VALUES (?, ?, 0, 'ZAR', 'active', 'ZA', 'user')`,
    ).run(walletId, userId);
  })();

  db.close();
  console.log(`  ✓ admin "${name}" → ${phone} (pin ${pin})`);
  return { id: userId, phone };
}

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  bootstrapAdmin().catch((err) => {
    console.error('Admin bootstrap failed:', err.message);
    process.exit(1);
  });
}
