import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { parseIntegerCents, type Cents } from '../money.js';
import { lockApprovedRequest, markApprovalExecuted } from '../security/approvalsPg.js';
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

  const originalMeta = await database.query<{
    transaction_type: string;
    from_wallet_id: string | null;
    to_wallet_id: string | null;
  }>(
    `SELECT j.transaction_type, t.from_wallet_id, t.to_wallet_id
       FROM journal_transactions j
       LEFT JOIN transactions t ON t.id = j.id::text
      WHERE j.id = $1 AND j.state IN ('posted','settled')`,
    [input.originalTransactionId],
  );
  const meta = originalMeta.rows[0];
  if (!meta) {
    throw Object.assign(new Error('Original transaction not found'), { status: 404 });
  }

  const typeToProduct: Record<string, typeof input.product> = {
    transfer: 'transfer',
    p2p_transfer: 'transfer',
    wallet_sale: 'wallet_sale',
    sale: 'wallet_sale',
    utility: 'utility',
    utility_purchase: 'utility',
    cash_send: 'cash_send',
    cash_send_hold: 'cash_send',
    loan_disbursement: 'loan',
    loan_repayment: 'loan',
    commission: 'commission',
    insurance_payout: 'insurance',
  };
  const inferred = typeToProduct[meta.transaction_type];
  if (inferred && inferred !== input.product) {
    throw Object.assign(
      new Error(
        `Refund product '${input.product}' does not match original transaction type '${meta.transaction_type}'.`,
      ),
      { status: 422, code: 'REFUND_PRODUCT_MISMATCH' },
    );
  }

  // P2P transfers: sender must not unilaterally claw funds from the recipient.
  // Only operators with an approved maker-checker request may reverse transfers.
  if (input.product === 'transfer') {
    if (input.requestedByType === 'user') {
      throw Object.assign(
        new Error(
          'Peer-to-peer transfer refunds require an operator dispute approval; senders cannot claw back unilaterally.',
        ),
        { status: 403, code: 'TRANSFER_REFUND_REQUIRES_OPS' },
      );
    }
    if (!input.approvalRequestId) {
      throw Object.assign(new Error('Approved maker-checker request required for transfer refunds'), {
        status: 403,
        code: 'APPROVAL_REQUIRED',
      });
    }
  }

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
    await lockApprovedRequest(database, {
      approvalRequestId: input.approvalRequestId,
      actionType: 'refund_reversal',
      resourceType: 'journal_transaction',
      resourceId: input.originalTransactionId,
      executorOperatorId: input.requestedById,
    });
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
    await markApprovalExecuted(
      database,
      input.approvalRequestId,
      input.requestedById,
      'Refund reversal executed',
    );
  }
  return { refundId, ...reversal };
}
