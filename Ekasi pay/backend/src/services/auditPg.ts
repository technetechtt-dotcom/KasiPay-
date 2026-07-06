import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

type DbClient = Pool | PoolClient;

export async function recordAuditEventPg(
  database: DbClient,
  input: {
    type: string;
    message: string;
    actorUserId?: string | null;
  },
): Promise<void> {
  await database.query(
    `INSERT INTO audit_events (id, type, message, actor_user_id, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      randomUUID(),
      input.type,
      input.message,
      input.actorUserId ?? null,
      new Date().toISOString(),
    ],
  );
}
