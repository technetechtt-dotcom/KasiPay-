import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export function recordAuditEvent(
  database: Database.Database,
  input: {
    type: string;
    message: string;
    actorUserId?: string | null;
  },
): void {
  database
    .prepare(
      `INSERT INTO audit_events (id, type, message, actor_user_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      input.type,
      input.message,
      input.actorUserId ?? null,
      new Date().toISOString(),
    );
}
