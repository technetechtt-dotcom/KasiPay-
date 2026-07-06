import fs from 'node:fs';

import Database from 'better-sqlite3';
import { Pool } from 'pg';

import { DATABASE_PATH, DATABASE_URL, IS_POSTGRES } from './config.js';

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
  sqliteDb = new Database(DATABASE_PATH, { readonly: true, fileMustExist: true });
  return sqliteDb;
}

export function getPgPool(): Pool {
  if (pgPool) return pgPool;
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL is required for Postgres mode.');
  }
  pgPool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  return pgPool;
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
