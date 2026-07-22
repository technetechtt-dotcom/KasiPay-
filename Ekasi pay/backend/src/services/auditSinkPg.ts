import type { Pool } from 'pg';

export interface ExternalAuditSink {
  deliver(event: {
    id: string;
    type: string;
    actorType: string;
    actorId: string | null;
    targetType: string | null;
    targetId: string | null;
    safeMetadata: unknown;
    requestId: string | null;
    correlationId: string | null;
    financialReference: string | null;
    createdAt: string;
  }): Promise<void>;
}

export async function deliverAuditOutboxPg(
  pool: Pool,
  sink: ExternalAuditSink,
  limit = 100,
): Promise<{ delivered: number; failed: number }> {
  const rows = await pool.query<{
    outbox_id: string; id: string; type: string; actor_type: string; actor_id: string | null;
    target_type: string | null; target_id: string | null; safe_metadata: unknown;
    request_id: string | null; correlation_id: string | null; financial_reference: string | null;
    created_at: string; attempts: number;
  }>(
    `UPDATE audit_sink_outbox o
        SET state = 'processing', locked_until = clock_timestamp() + interval '2 minutes',
            attempts = attempts + 1
      FROM (
        SELECT id FROM audit_sink_outbox
         WHERE state IN ('pending','failed')
           AND available_at <= clock_timestamp()
           AND (locked_until IS NULL OR locked_until < clock_timestamp())
         ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED
      ) claim, audit_events e
      WHERE o.id = claim.id AND e.id = o.audit_event_id
      RETURNING o.id outbox_id, e.id, e.type, e.actor_type, e.actor_id,
                e.target_type, e.target_id, e.safe_metadata, e.request_id,
                e.correlation_id, e.financial_reference, e.created_at, o.attempts`,
    [limit],
  );
  let delivered = 0;
  let failed = 0;
  for (const row of rows.rows) {
    try {
      await sink.deliver({
        id: row.id, type: row.type, actorType: row.actor_type, actorId: row.actor_id,
        targetType: row.target_type, targetId: row.target_id, safeMetadata: row.safe_metadata,
        requestId: row.request_id, correlationId: row.correlation_id,
        financialReference: row.financial_reference, createdAt: row.created_at,
      });
      await pool.query(
        `UPDATE audit_sink_outbox SET state = 'sent', delivered_at = clock_timestamp(),
                locked_until = NULL, last_error = NULL WHERE id = $1`,
        [row.outbox_id],
      );
      delivered += 1;
    } catch (error) {
      const dead = row.attempts >= 10;
      await pool.query(
        `UPDATE audit_sink_outbox
            SET state = $2, available_at = clock_timestamp() + make_interval(secs => LEAST(3600, power(2, attempts)::int)),
                locked_until = NULL, last_error = $3
          WHERE id = $1`,
        [row.outbox_id, dead ? 'dead_letter' : 'failed', error instanceof Error ? error.message.slice(0, 500) : 'sink failure'],
      );
      failed += 1;
    }
  }
  return { delivered, failed };
}
