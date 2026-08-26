import type { PoolClient } from 'pg';

import { BANK_WEBHOOK_SECRET } from '../config.js';
import { parseIntegerCents } from '../money.js';
import { ingestBankDepositPg } from './bankDepositMatchingPg.js';
import {
  reverseBankTransactionPg,
  settleBankTransactionPg,
  type BankLifecycleStatus,
} from './bankTransactionLifecyclePg.js';
import {
  claimWebhookEventPg,
  completeWebhookEventPg,
  verifyWebhookSignature,
} from './webhookInboxPg.js';

export type BankWebhookEvent = {
  eventId: string;
  eventType: 'credit.received' | 'credit.settled' | 'credit.reversed' | 'credit.rejected';
  occurredAt: string;
  bankReference: string;
  merchantReference?: string;
  amountCents: string;
  currency: string;
  valueDate: string;
  destinationAccount?: string;
  sourceAccountFingerprint?: string;
  reversalOfEventId?: string;
};

export async function ingestSignedBankWebhookPg(
  client: PoolClient,
  input: {
    rawPayload: Buffer;
    signature: string;
    payload: BankWebhookEvent;
    actorId?: string;
  },
): Promise<{ duplicate: boolean; bankTransactionId?: string; matchState?: string }> {
  if (!BANK_WEBHOOK_SECRET) {
    throw Object.assign(new Error('BANK_WEBHOOK_SECRET is not configured'), {
      status: 503,
      code: 'BANK_WEBHOOK_UNCONFIGURED',
    });
  }
  if (!verifyWebhookSignature(input.rawPayload, input.signature, BANK_WEBHOOK_SECRET)) {
    throw Object.assign(new Error('Invalid bank webhook signature'), { status: 401 });
  }
  const claimed = await claimWebhookEventPg(client, {
    provider: 'bank_partner',
    eventId: input.payload.eventId,
    eventType: input.payload.eventType,
    occurredAt: new Date(input.payload.occurredAt),
    rawPayload: input.rawPayload,
    payload: input.payload,
    signature: input.signature,
  });
  if (!claimed.claimed) {
    await completeWebhookEventPg(client, claimed.id);
    return { duplicate: true };
  }

  const lifecycle: BankLifecycleStatus =
    input.payload.eventType === 'credit.rejected' ? 'rejected'
    : input.payload.eventType === 'credit.reversed' ? 'received'
    : input.payload.eventType === 'credit.settled' ? 'received'
    : 'received';

  const ingested = await ingestBankDepositPg(client, {
    bankReference: input.payload.bankReference,
    merchantReference: input.payload.merchantReference,
    amountCents: parseIntegerCents(input.payload.amountCents),
    currency: input.payload.currency,
    direction: 'credit',
    valueDate: input.payload.valueDate,
    destinationAccount: input.payload.destinationAccount,
    sourceAccountFingerprint: input.payload.sourceAccountFingerprint,
    providerEventId: input.payload.eventId,
    lifecycleStatus: lifecycle,
  });

  if (input.payload.eventType === 'credit.settled') {
    await settleBankTransactionPg(client, {
      bankTransactionId: ingested.id,
      actorId: input.actorId ?? 'bank_webhook',
      settlementDate: input.payload.valueDate,
    });
  }
  if (input.payload.eventType === 'credit.reversed') {
    await reverseBankTransactionPg(client, {
      bankTransactionId: ingested.id,
      actorId: input.actorId ?? 'bank_webhook',
      reversalReference: input.payload.reversalOfEventId ?? input.payload.eventId,
      reason: 'Provider reversal webhook',
    });
  }

  await completeWebhookEventPg(client, claimed.id);
  return {
    duplicate: false,
    bankTransactionId: ingested.id,
    matchState: ingested.matchState,
  };
}
