import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import { getPgPool } from '../dbPg.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireCapability } from '../security/authorization.js';
import { parseIntegerCents } from '../money.js';
import { postRefundPg } from '../services/refundsPg.js';

export const refundsRouterPg = Router();

const refundBody = z.object({
  originalTransactionId: z.string().uuid(),
  product: z.enum([
    'wallet_sale', 'transfer', 'utility', 'cash_send', 'loan', 'commission', 'insurance',
  ]),
  amountCents: z.string().regex(/^[0-9]+$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  reason: z.string().trim().min(10).max(1000),
  approvalRequestId: z.string().uuid().optional(),
  stockCompensation: z.record(z.unknown()).optional(),
  domainCompensation: z.record(z.unknown()).optional(),
});

refundsRouterPg.post('/refunds', requireAuth, async (req, res) => {
  const parsed = refundBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const idempotencyKey = String(req.headers['idempotency-key'] ?? '');
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
    return res.status(400).json({ error: 'A valid Idempotency-Key header is required' });
  }
  const client = await getPgPool().connect();
  try {
    await client.query('BEGIN');
    const original = await client.query<{ owner_id: string | null }>(
      `SELECT w.user_id AS owner_id
         FROM journal_transactions j
         LEFT JOIN transactions t ON t.id = j.id::text
         LEFT JOIN wallets w ON w.id = t.from_wallet_id
        WHERE j.id = $1 AND j.state IN ('posted','settled') FOR UPDATE OF j`,
      [parsed.data.originalTransactionId],
    );
    if (!original.rows[0] || original.rows[0].owner_id !== req.auth!.userId) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Refundable transaction not found' });
    }
    const result = await postRefundPg(client, {
      ...parsed.data,
      amountCents: parseIntegerCents(parsed.data.amountCents),
      requestedByType: 'user',
      requestedById: req.auth!.userId,
      idempotencyKey,
    });
    await client.query(
      `INSERT INTO audit_events
         (id,type,message,actor_user_id,created_at,actor_type,actor_id,target_type,
          target_id,safe_metadata,reason,request_id,correlation_id,financial_reference)
       VALUES ($1,'refund.posted','Compensating refund posted',$2,clock_timestamp(),
               'user',$2,'refund_request',$3,$4::jsonb,$5,$6,$7,$8)`,
      [
        randomUUID(),
        req.auth!.userId,
        result.refundId,
        JSON.stringify({ product: parsed.data.product, amountCents: parsed.data.amountCents }),
        parsed.data.reason,
        req.requestId,
        req.correlationId,
        result.reference,
      ],
    );
    await client.query('COMMIT');
    return res.status(201).json(result);
  } catch (error) {
    await client.query('ROLLBACK');
    const status = (error as { status?: number }).status;
    if (status) return res.status(status).json({ error: (error as Error).message });
    throw error;
  } finally {
    client.release();
  }
});

refundsRouterPg.get(
  '/ops/refunds',
  ...requireCapability('finance:approve'),
  async (_req, res) => {
    const rows = await getPgPool().query(
      `SELECT r.*,o.reference AS original_reference,c.reference AS refund_reference
         FROM refund_requests r
         JOIN journal_transactions o ON o.id = r.original_journal_transaction_id
         LEFT JOIN journal_transactions c ON c.id = r.compensating_journal_transaction_id
        ORDER BY r.created_at DESC LIMIT 500`,
    );
    return res.json({ refunds: rows.rows });
  },
);
