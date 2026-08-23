import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { parseIntegerCents, type Cents } from '../money.js';
import { observeMetric } from '../observability.js';
import { evaluateTransactionRiskPg } from '../services/riskPg.js';
import { postBetweenWalletsPg } from '../services/walletPostingPg.js';
import { routePayment } from './paymentRouter.js';
import type { PaymentIntent, PaymentProduct, PaymentRailId, PaymentResult } from './types.js';

type Db = Pool | PoolClient;

export async function createPaymentIntentPg(
  database: Db,
  input: {
    product: PaymentProduct;
    requestedRail?: PaymentRailId;
    amountCents: Cents;
    currency: string;
    poolId: string;
    actorUserId: string;
    counterpartyUserId?: string;
    sourceWalletId?: string;
    destinationWalletId?: string;
    idempotencyKey?: string;
    originalPaymentId?: string;
    requestId: string;
    correlationId: string;
    deviceId?: string;
    ip?: string;
    counterparty?: string;
  },
): Promise<{ intent: PaymentIntent; riskDecision: 'allow' | 'review' | 'hold' | 'block' }> {
  const rail = routePayment({
    product: input.product,
    requestedRail: input.requestedRail,
    amountCents: input.amountCents,
  });
  const amountCents = parseIntegerCents(input.amountCents, { allowZero: true });
  const id = randomUUID();
  const financialReference = `PAY-${id.slice(0, 8).toUpperCase()}`;
  const risk = await evaluateTransactionRiskPg(database, {
    eventType:
      input.product === 'cash_send'
        ? 'voucher'
        : input.product === 'float_withdrawal'
          ? 'cash_out'
          : 'transfer',
    actorUserId: input.actorUserId,
    amountCents,
    financialReference,
    deviceId: input.deviceId,
    ip: input.ip,
    counterparty: input.counterparty,
    requestId: input.requestId,
    correlationId: input.correlationId,
  });
  const state =
    risk.decision === 'block'
      ? 'failed'
      : risk.decision === 'hold'
        ? 'pending'
        : 'created';
  await database.query(
    `INSERT INTO payment_intents
       (id, product, rail, state, amount_cents, currency, pool_id, actor_user_id,
        counterparty_user_id, source_wallet_id, destination_wallet_id,
        financial_reference, idempotency_key, original_payment_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      id,
      input.product,
      rail.id,
      state,
      amountCents.toString(),
      input.currency,
      input.poolId,
      input.actorUserId,
      input.counterpartyUserId ?? null,
      input.sourceWalletId ?? null,
      input.destinationWalletId ?? null,
      financialReference,
      input.idempotencyKey ?? null,
      input.originalPaymentId ?? null,
    ],
  );
  observeMetric('payments.created');
  if (risk.decision === 'hold') observeMetric('risk.hold');
  if (risk.decision === 'block') observeMetric('risk.block');
  return {
    intent: {
      id,
      product: input.product,
      rail: rail.id,
      state,
      amountCents,
      currency: input.currency,
      poolId: input.poolId,
      actorUserId: input.actorUserId,
      counterpartyUserId: input.counterpartyUserId,
      sourceWalletId: input.sourceWalletId,
      destinationWalletId: input.destinationWalletId,
      financialReference,
      idempotencyKey: input.idempotencyKey,
      originalPaymentId: input.originalPaymentId,
    },
    riskDecision: risk.decision,
  };
}

export async function captureInternalWalletPaymentPg(
  client: PoolClient,
  intent: PaymentIntent,
): Promise<PaymentResult> {
  if (intent.rail !== 'internal_wallet') {
    throw Object.assign(new Error('Only the internal wallet rail can capture here'), {
      status: 400,
    });
  }
  if (!intent.sourceWalletId || !intent.destinationWalletId) {
    throw Object.assign(new Error('Wallet endpoints are required'), { status: 400 });
  }
  if (intent.amountCents === 0n) {
    await client.query(`UPDATE payment_intents SET state = 'fulfilled' WHERE id = $1`, [
      intent.id,
    ]);
    observeMetric('payments.fulfilled');
    return {
      intentId: intent.id,
      state: 'fulfilled',
      rail: intent.rail,
      reference: intent.financialReference,
    };
  }
  const posted = await postBetweenWalletsPg(client, {
    fromWalletId: intent.sourceWalletId,
    toWalletId: intent.destinationWalletId,
    amountCents: intent.amountCents,
    type: intent.product,
    referencePrefix: 'PAY',
    reference: intent.financialReference,
    description: `${intent.product} ${intent.financialReference}`,
    actorId: intent.actorUserId,
  });
  await client.query(
    `UPDATE payment_intents
        SET state = 'fulfilled', journal_transaction_id = $2
      WHERE id = $1`,
    [intent.id, posted.transactionId],
  );
  observeMetric('payments.fulfilled');
  observeMetric('wallet.posting.success');
  return {
    intentId: intent.id,
    state: 'fulfilled',
    rail: intent.rail,
    transactionId: posted.transactionId,
    reference: posted.reference,
  };
}
