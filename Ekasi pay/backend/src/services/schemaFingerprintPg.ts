import { createHash } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

type Db = Pool | PoolClient;

export type SchemaFingerprint = {
  schemaMigrations: number;
  schemaFingerprint: string;
};

export async function schemaFingerprintPg(database: Db): Promise<SchemaFingerprint> {
  const rows = await database.query<{ name: string }>(
    `SELECT name FROM schema_migrations ORDER BY name`,
  );
  const names = rows.rows.map((row) => row.name).join(',');
  return {
    schemaMigrations: rows.rows.length,
    schemaFingerprint: createHash('sha256').update(names).digest('hex').slice(0, 16),
  };
}
