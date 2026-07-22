import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { parseIntegerCents, type Cents } from '../money.js';
import { reverseWalletPostingPg } from './walletPostingPg.js';

export const REFUND_CHECKER_THRESHOLD_CENTS = 100_000n as Cents;

export async function refundableCeilingPg(
  database: PoolClient,
  originalTransactionId: string,
): Promise<Cents> {
  const result = await database.query<{ original_cents: string; refunded_cents: string }>(
    `SELECT
       COALESCE((SELECT sum(amount_cents) FROM journal_entries
                  WHERE transaction_id = $1 AND side = 'debit'), 0)::text AS original_cents,
       COALESCE((SELECT sum(e.amount_cents)
                   FROM journal_transactions r
                   JOIN journal_entries e ON e.transaction_id = r.id AND e.side = 'debit'
                  WHERE r.original_transaction_id = $1
                    AND r.state IN ('posted','settled')), 0)::text AS refunded_cents`,
    [originalTransactionId],
  );
  const row = result.rows[0];
  return (BigInt(row?.original_cents ?? '0') - BigInt(row?.refunded_cents ?? '0')) as Cents;
}

export async function postRefundPg(
  database: PoolClient,
  input: {
    originalTransactionId: string;
    product: 'wallet_sale' | 'transfer' | 'utility' | 'cash_send' | 'loan' | 'commission' | 'insurance';
    amountCents: Cents;
    currency: string;
    reason: string;
    requestedByType: 'user' | 'operator' | 'system';
    requestedById: string;
    idempotencyKey: string;
    approvalRequestId?: string;
    stockCompensation?: unknown;
    domainCompensation?: unknown;
  },
): Promise<{ refundId: string; transactionId: string; reference: string }> {
  const amount = parseIntegerCents(input.amountCents);
  const ceiling = await refundableCeilingPg(database, input.originalTransactionId);
  if (amount > ceiling) {
    throw Object.assign(new Error('Refund exceeds remaining refundable ceiling'), { status: 409 });
  }
  if (amount >= REFUND_CHECKER_THRESHOLD_CENTS && !input.approvalRequestId) {
    throw Object.assign(new Error('Approved maker-checker request required'), {
      status: 403,
      code: 'APPROVAL_REQUIRED',
    });
  }
  if (input.approvalRequestId) {
    const approved = await database.query(
      `SELECT 1 FROM approval_requests
        WHERE id = $1 AND action_type = 'refund_reversal' AND state = 'approved'
          AND expires_at > clock_timestamp()`,
      [input.approvalRequestId],
    );
    if (!approved.rowCount) throw Object.assign(new Error('Approval is not valid'), { status: 409 });
  }

  const existing = await database.query<{ id: string; compensating_journal_transaction_id: string }>(
    `SELECT id, compensating_journal_transaction_id FROM refund_requests
      WHERE requested_by_type = $1 AND requested_by_id = $2 AND idempotency_key = $3`,
    [input.requestedByType, input.requestedById, input.idempotencyKey],
  );
  if (existing.rows[0]?.compensating_journal_transaction_id) {
    const transaction = await database.query<{ reference: string }>(
      `SELECT reference FROM journal_transactions WHERE id = $1`,
      [existing.rows[0].compensating_journal_transaction_id],
    );
    return {
      refundId: existing.rows[0].id,
      transactionId: existing.rows[0].compensating_journal_transaction_id,
      reference: transaction.rows[0]?.reference ?? '',
    };
  }

  const refundId = randomUUID();
  await database.query(
    `INSERT INTO refund_requests
       (id, original_journal_transaction_id, product, requested_cents,
        refundable_ceiling_cents, currency, state, reason, stock_compensation,
        domain_compensation, approval_request_id, idempotency_key,
        requested_by_type, requested_by_id)
     VALUES ($1,$2,$3,$4,$5,$6,'approved',$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13)`,
    [
      refundId,
      input.originalTransactionId,
      input.product,
      amount.toString(),
      ceiling.toString(),
      input.currency,
      input.reason,
      JSON.stringify(input.stockCompensation ?? null),
      JSON.stringify(input.domainCompensation ?? null),
      input.approvalRequestId ?? null,
      input.idempotencyKey,
      input.requestedByType,
      input.requestedById,
    ],
  );
  const reversal = await reverseWalletPostingPg(database, {
    originalTransactionId: input.originalTransactionId,
    amountCents: amount,
    kind: 'refund',
    referencePrefix: 'RFD',
    description: `Refund: ${input.reason}`,
    actorId: input.requestedById,
  });
  await database.query(
    `UPDATE refund_requests
        SET state = 'posted', compensating_journal_transaction_id = $2,
            posted_at = clock_timestamp()
      WHERE id = $1`,
    [refundId, reversal.transactionId],
  );
  if (input.approvalRequestId) {
    await database.query(
      `UPDATE approval_requests SET state = 'executed', executed_at = clock_timestamp()
        WHERE id = $1 AND state = 'approved'`,
      [input.approvalRequestId],
    );
  }
  return { refundId, ...reversal };
}
