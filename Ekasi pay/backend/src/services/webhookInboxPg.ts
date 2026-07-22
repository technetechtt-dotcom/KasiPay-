import { createHash, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

export function verifyWebhookSignature(
  rawPayload: Buffer,
  suppliedSignature: string,
  secret: string,
): boolean {
  const expected = createHmac('sha256', secret).update(rawPayload).digest('hex');
  const supplied = suppliedSignature.replace(/^sha256=/, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(supplied)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(supplied, 'hex'));
}

/**
 * Inserts and locks a provider event in the caller's transaction. A repeated
 * provider/event id returns the original row and can never run twice.
 */
export async function claimWebhookEventPg(
  client: PoolClient,
  event: {
    provider: string;
    eventId: string;
    eventType: string;
    occurredAt: Date;
    rawPayload: Buffer;
    payload: unknown;
    signature: string;
  },
): Promise<{ id: string; claimed: boolean }> {
  const payloadHash = createHash('sha256').update(event.rawPayload).digest('hex');
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO webhook_inbox
       (id, provider, event_id, event_type, occurred_at, payload_hash,
        signature, payload, state, attempts, locked_until)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'processing',1,
             clock_timestamp() + interval '2 minutes')
     ON CONFLICT (provider, event_id) DO NOTHING
     RETURNING id`,
    [
      randomUUID(),
      event.provider,
      event.eventId,
      event.eventType,
      event.occurredAt.toISOString(),
      payloadHash,
      event.signature,
      JSON.stringify(event.payload),
    ],
  );
  if (inserted.rows[0]) return { id: inserted.rows[0].id, claimed: true };

  const existing = await client.query<{ id: string; payload_hash: string }>(
    `SELECT id, payload_hash FROM webhook_inbox
      WHERE provider = $1 AND event_id = $2 FOR UPDATE`,
    [event.provider, event.eventId],
  );
  const row = existing.rows[0];
  if (!row) throw new Error('Webhook claim disappeared');
  if (row.payload_hash !== payloadHash) {
    throw Object.assign(new Error('Webhook event id payload mismatch'), { status: 409 });
  }
  return { id: row.id, claimed: false };
}

export async function completeWebhookEventPg(
  client: PoolClient,
  inboxId: string,
): Promise<void> {
  await client.query(
    `UPDATE webhook_inbox
        SET state = 'processed', processed_at = clock_timestamp(), locked_until = NULL
      WHERE id = $1 AND state = 'processing'`,
    [inboxId],
  );
}
