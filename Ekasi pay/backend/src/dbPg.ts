import { Pool } from 'pg';

import { assertSchemaReady } from './migrations.js';
import { pgPoolSsl } from './pgSsl.js';

let pool: Pool | null = null;

function databaseUrl(): string {
  return process.env.DATABASE_URL?.trim() ?? '';
}

function ensurePool(): Pool {
  if (pool) return pool;
  const connectionString = databaseUrl();
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for Postgres mode.');
  }
  pool = new Pool({
    connectionString,
    ssl: pgPoolSsl(connectionString),
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
