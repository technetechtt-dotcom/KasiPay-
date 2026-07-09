import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import { Pool } from 'pg';

import {
  DATABASE_PATH,
  DATABASE_URL,
  IS_POSTGRES,
  NODE_ENV,
  OPS_SUPER_ADMIN_PASSWORD,
  OPS_SUPER_ADMIN_USERNAME,
} from './config.js';
import { pgPoolSsl } from './pgSsl.js';

let sqliteDb: Database.Database | null = null;
let pgPool: Pool | null = null;

export function isPostgresMode(): boolean {
  return IS_POSTGRES;
}

export function getSqliteDb(): Database.Database {
  if (sqliteDb) return sqliteDb;
  if (!fs.existsSync(DATABASE_PATH)) {
    throw new Error(
      `SQLite database not found at ${DATABASE_PATH}. Set DATABASE_PATH or DATABASE_URL.`,
    );
  }
  sqliteDb = new Database(DATABASE_PATH, { fileMustExist: true });
  return sqliteDb;
}

export function getPgPool(): Pool {
  if (pgPool) return pgPool;
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL is required for Postgres mode.');
  }
  pgPool = new Pool({
    connectionString: DATABASE_URL,
    ssl: pgPoolSsl(DATABASE_URL),
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  return pgPool;
}

export async function initOpsAuthStore(): Promise<void> {
  const superUsername = OPS_SUPER_ADMIN_USERNAME.trim().toLowerCase();
  const superPassword = OPS_SUPER_ADMIN_PASSWORD.trim();
  if (!superUsername || !superPassword) {
    throw new Error('OPS super admin username and password must be configured.');
  }
  const passwordHash =
    superPassword.startsWith('$2a$') || superPassword.startsWith('$2b$')
      ? superPassword
      : await bcrypt.hash(superPassword, 12);
  const now = new Date().toISOString();

  if (isPostgresMode()) {
    const pool = getPgPool();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ops_admin_users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        last_login_at TIMESTAMPTZ
      )
    `);
    await pool.query(
      `INSERT INTO ops_admin_users (id, username, password_hash, role, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, 'super_admin', TRUE, $4, $4)
       ON CONFLICT (username) DO NOTHING`,
      [randomUUID(), superUsername, passwordHash, now],
    );
    return;
  }

  const db = getSqliteDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS ops_admin_users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT
    )
  `);
  db.prepare(
    `INSERT OR IGNORE INTO ops_admin_users
      (id, username, password_hash, role, is_active, created_at, updated_at)
     VALUES (?, ?, ?, 'super_admin', 1, ?, ?)`,
  ).run(randomUUID(), superUsername, passwordHash, now, now);
}

export async function closeDataStore(): Promise<void> {
  if (pgPool) {
    const p = pgPool;
    pgPool = null;
    await p.end();
  }
  if (sqliteDb) {
    sqliteDb.close();
    sqliteDb = null;
  }
}
