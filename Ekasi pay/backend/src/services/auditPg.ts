import { createHash, randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

type DbClient = Pool | PoolClient;

export function safeAuditHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value, Object.keys((value ?? {}) as object).sort()))
    .digest('hex');
}

export async function recordAuditEventPg(
  database: DbClient,
  input: {
    type: string;
    message: string;
    actorUserId?: string | null;
    actorType?: 'user' | 'operator' | 'system' | 'provider';
    actorId?: string | null;
    targetType?: string;
    targetId?: string;
    beforeHash?: string;
    afterHash?: string;
    safeMetadata?: Record<string, unknown>;
    reason?: string;
    ipHash?: string;
    deviceHash?: string;
    requestId?: string;
    correlationId?: string;
    financialReference?: string;
  },
): Promise<void> {
  await database.query(
    `INSERT INTO audit_events (
       id, type, message, actor_user_id, created_at, actor_type, actor_id,
       target_type, target_id, before_hash, after_hash, safe_metadata, reason,
       ip_hash, device_hash, request_id, correlation_id, financial_reference
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18
     )`,
    [
      randomUUID(),
      input.type,
      input.message,
      input.actorUserId ?? null,
      new Date().toISOString(),
      input.actorType ?? (input.actorUserId ? 'user' : 'system'),
      input.actorId ?? input.actorUserId ?? null,
      input.targetType ?? null,
      input.targetId ?? null,
      input.beforeHash ?? null,
      input.afterHash ?? null,
      JSON.stringify(input.safeMetadata ?? {}),
      input.reason ?? null,
      input.ipHash ?? null,
      input.deviceHash ?? null,
      input.requestId ?? null,
      input.correlationId ?? null,
      input.financialReference ?? null,
    ],
  );
}
