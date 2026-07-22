import { Pool } from 'pg';

import { DATABASE_URL } from './config.js';
import { assertSchemaReady } from './migrations.js';
import { pgPoolSsl } from './pgSsl.js';

let pool: Pool | null = null;

function ensurePool(): Pool {
  if (pool) return pool;
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL is required for Postgres mode.');
  }
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: pgPoolSsl(DATABASE_URL),
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  return pool;
}

export async function initPg(): Promise<void> {
  await assertSchemaReady(ensurePool());
}

export function getPgPool(): Pool {
  return ensurePool();
}

export async function closePg(): Promise<void> {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}
