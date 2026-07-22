/**
 * Deliver pending audit_sink_outbox rows to the configured HTTP sink.
 *
 *   DATABASE_URL=... AUDIT_SINK_ENDPOINT=... AUDIT_SINK_API_KEY=... npm run audit:deliver
 */
import 'dotenv/config';

import pg from 'pg';

import { deliverAuditOutboxPg } from '../src/services/auditSinkPg.ts';
import { createHttpAuditSink } from '../src/services/httpAuditSink.ts';

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('DATABASE_URL is required.');

const pool = new pg.Pool({ connectionString: databaseUrl });
try {
  const sink = createHttpAuditSink();
  const result = await deliverAuditOutboxPg(pool, sink, Number(process.env.AUDIT_SINK_BATCH ?? 100));
  console.log(JSON.stringify({ ok: true, ...result, ranAt: new Date().toISOString() }));
  if (result.failed > 0) process.exitCode = 2;
} finally {
  await pool.end();
}
