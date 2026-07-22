import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import { IS_LOCAL_ENV, PROVIDER_CALLBACK_SECRET } from '../config.js';
import { getPgPool } from '../dbPg.js';
import {
  providerPayloadHash,
  verifyProviderCallback,
} from '../services/providerFrameworkPg.js';

export const providerCallbacksRouterPg = Router();

const callbackBody = z.object({
  eventId: z.string().min(1).max(200),
  providerReference: z.string().min(1).max(200),
  state: z.enum(['accepted', 'fulfilled', 'failed', 'unknown', 'reversed']),
  response: z.record(z.unknown()).default({}),
});

providerCallbacksRouterPg.post('/providers/:endpointId/callback', async (req, res) => {
  const parsed = callbackBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const timestamp = String(req.headers['x-provider-timestamp'] ?? '');
  const signature = String(req.headers['x-provider-signature'] ?? '');
  const secret = PROVIDER_CALLBACK_SECRET || (IS_LOCAL_ENV ? 'sandbox-callback-secret' : '');
  if (!secret || !verifyProviderCallback({
    secret,
    timestamp,
    signature,
    payload: parsed.data,
  })) {
    return res.status(401).json({ error: 'Invalid or stale provider signature' });
  }
  const client = await getPgPool().connect();
  try {
    await client.query('BEGIN');
    const endpoint = await client.query<{ environment: string }>(
      `SELECT environment FROM provider_endpoints WHERE id = $1 AND enabled`,
      [req.params.endpointId],
    );
    if (!endpoint.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Provider endpoint not found' });
    }
    if (!IS_LOCAL_ENV && endpoint.rows[0].environment !== 'production') {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Sandbox callback rejected in deployed environment' });
    }
    const inboxId = randomUUID();
    const inserted = await client.query(
      `INSERT INTO provider_callback_inbox
         (id,endpoint_id,provider_event_id,provider_reference,provider_timestamp,
          signature,payload,payload_sha256)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
       ON CONFLICT DO NOTHING RETURNING id`,
      [
        inboxId,
        req.params.endpointId,
        parsed.data.eventId,
        parsed.data.providerReference,
        timestamp,
        signature,
        JSON.stringify(parsed.data),
        providerPayloadHash(parsed.data),
      ],
    );
    if (!inserted.rowCount) {
      await client.query('COMMIT');
      return res.status(200).json({ duplicate: true });
    }
    const instruction = await client.query<{ id: string; state: string }>(
      `SELECT id,state FROM provider_instructions
        WHERE endpoint_id = $1 AND provider_reference = $2 FOR UPDATE`,
      [req.params.endpointId, parsed.data.providerReference],
    );
    const row = instruction.rows[0];
    if (!row) {
      await client.query(
        `UPDATE provider_callback_inbox
            SET state = 'rejected',rejection_reason = 'instruction_not_found',
                processed_at = clock_timestamp() WHERE id = $1`,
        [inboxId],
      );
      await client.query('COMMIT');
      return res.status(202).json({ accepted: true, matched: false });
    }
    if (row.state === 'fulfilled' && parsed.data.state !== 'reversed') {
      await client.query(
        `UPDATE provider_callback_inbox
            SET state = 'processed',processed_at = clock_timestamp() WHERE id = $1`,
        [inboxId],
      );
      await client.query('COMMIT');
      return res.json({ accepted: true, terminalReplay: true });
    }
    await client.query(
      `UPDATE provider_instructions
          SET state = $2,response_sha256 = $3,
              fulfilled_at = CASE WHEN $2 = 'fulfilled' THEN clock_timestamp() ELSE fulfilled_at END,
              updated_at = clock_timestamp()
        WHERE id = $1`,
      [row.id, parsed.data.state, providerPayloadHash(parsed.data.response)],
    );
    await client.query(
      `UPDATE provider_callback_inbox
          SET state = 'processed',processed_at = clock_timestamp() WHERE id = $1`,
      [inboxId],
    );
    await client.query('COMMIT');
    return res.json({ accepted: true });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});
