import { createHash, randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { parseIntegerCents, type Cents } from '../money.js';
import { observeMetric } from '../observability.js';
import { isApprovedClientFundsDestinationPg } from './clientFundsAccountsPg.js';
import { parseMerchantFloatReference } from './floatReference.js';
import {
  recordBankLifecycleEventPg,
  type BankLifecycleStatus,
} from './bankTransactionLifecyclePg.js';

type Db = Pool | PoolClient;

export type BankDepositInput = {
  bankReference: string;
  merchantReference?: string;
  amountCents: Cents;
  currency: string;
  direction: 'credit' | 'debit';
  valueDate: string;
  sourceAccountFingerprint?: string;
  destinationAccount?: string;
  statementFileId?: string;
  poolId?: string;
  providerEventId?: string;
  lifecycleStatus?: BankLifecycleStatus;
};

export type BankMatchState = 'matched' | 'partial' | 'duplicate' | 'unmatched' | 'suspense';

function isPoolClient(database: Db): database is PoolClient {
  return typeof (database as PoolClient).release === 'function';
}

function rawHash(input: BankDepositInput): string {
  return createHash('sha256')
    .update(
      [
        input.bankReference,
        input.merchantReference ?? '',
        input.amountCents.toString(),
        input.currency,
        input.direction,
        input.valueDate,
        input.sourceAccountFingerprint ?? '',
        input.destinationAccount ?? '',
      ].join('|'),
    )
    .digest('hex');
}

export function classifyBankDepositMatch(input: {
  exactMatches: number;
  amountMatches: number;
  alreadyMatched: boolean;
  creditOnly?: boolean;
  clientFundsDestination?: boolean;
}): BankMatchState {
  if (input.creditOnly === false) return 'unmatched';
  if (input.clientFundsDestination === false) return 'unmatched';
  if (input.alreadyMatched) return 'duplicate';
  if (input.exactMatches === 1) return 'matched';
  if (input.exactMatches > 1) return 'duplicate';
  if (input.amountMatches >= 1) return 'partial';
  return 'unmatched';
}

async function ingestBankDepositLocked(
  database: PoolClient,
  input: BankDepositInput,
): Promise<{ id: string; matchState: BankMatchState; topupId?: string }> {
  const amount = parseIntegerCents(input.amountCents);
  const hash = rawHash({ ...input, amountCents: amount });
  const existing = await database.query<{ id: string; match_state: BankMatchState }>(
    `SELECT id, match_state FROM bank_transactions WHERE raw_hash = $1`,
    [hash],
  );
  if (existing.rows[0]) {
    observeMetric('float.topup.unmatched');
    return { id: existing.rows[0].id, matchState: 'duplicate' };
  }
  if (input.providerEventId) {
    const byEvent = await database.query<{ id: string; match_state: BankMatchState }>(
      `SELECT id, match_state FROM bank_transactions WHERE provider_event_id = $1`,
      [input.providerEventId],
    );
    if (byEvent.rows[0]) {
      return { id: byEvent.rows[0].id, matchState: 'duplicate' };
    }
  }

  const clientFundsApproved = await isApprovedClientFundsDestinationPg(database, {
    destinationAccount: input.destinationAccount,
    currency: input.currency,
    poolId: input.poolId ?? 'ZA',
  });
  const merchantReference = input.merchantReference?.trim();
  const validReference = merchantReference
    ? parseMerchantFloatReference(merchantReference)
    : null;
  const exact =
    validReference && merchantReference
      ? await database.query<{ id: string; amount_cents: string; state: string }>(
          `SELECT id, amount_cents, state FROM merchant_float_topups
            WHERE merchant_reference = $1 AND currency = $2
            FOR UPDATE`,
          [merchantReference, input.currency],
        )
      : { rows: [] as Array<{ id: string; amount_cents: string; state: string }> };

  const amountOnly = merchantReference
    ? await database.query<{ id: string }>(
        `SELECT id FROM merchant_float_topups
          WHERE currency = $1 AND amount_cents = $2
            AND merchant_reference <> $3
            AND state IN ('requested','awaiting_bank_match')`,
        [input.currency, amount.toString(), merchantReference],
      )
    : { rows: [] };

  const credited = exact.rows.filter((row) =>
    ['matched', 'approved', 'credited'].includes(row.state),
  );
  const pending = exact.rows.filter((row) =>
    ['requested', 'awaiting_bank_match'].includes(row.state),
  );
  const exactAmount = pending.filter((row) => BigInt(row.amount_cents) === amount);
  const matchState = classifyBankDepositMatch({
    exactMatches: exactAmount.length,
    amountMatches: pending.length - exactAmount.length + amountOnly.rows.length,
    alreadyMatched: credited.length > 0,
    creditOnly: input.direction === 'credit',
    clientFundsDestination: clientFundsApproved,
  });

  const id = randomUUID();
  let topupId = matchState === 'matched' ? exactAmount[0]?.id : undefined;
  if (topupId) {
    const claimed = await database.query(
      `UPDATE merchant_float_topups
          SET state = 'matched', bank_transaction_id = $2, updated_at = clock_timestamp()
        WHERE id = $1
          AND state IN ('requested','awaiting_bank_match')
          AND bank_transaction_id IS NULL`,
      [topupId, id],
    );
    if (!claimed.rowCount) {
      topupId = undefined;
    }
  }

  const persistedState: BankMatchState = topupId
    ? 'matched'
    : matchState === 'unmatched' || matchState === 'partial' || matchState === 'matched'
      ? 'suspense'
      : matchState;

  const lifecycle: BankLifecycleStatus =
    input.lifecycleStatus && input.lifecycleStatus !== 'settled'
      ? input.lifecycleStatus
      : 'received';
  await database.query(
    `INSERT INTO bank_transactions
       (id, bank_reference, merchant_reference, amount_cents, currency, direction,
        value_date, source_account_fingerprint, destination_account, raw_hash,
        statement_file_id, match_state, matched_topup_id, lifecycle_status,
        provider_event_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      id,
      input.bankReference,
      input.merchantReference ?? null,
      amount.toString(),
      input.currency,
      input.direction,
      input.valueDate,
      input.sourceAccountFingerprint ?? null,
      input.destinationAccount ?? null,
      hash,
      input.statementFileId ?? null,
      persistedState,
      topupId ?? null,
      lifecycle,
      input.providerEventId ?? null,
    ],
  );
  await recordBankLifecycleEventPg(database, {
    bankTransactionId: id,
    fromStatus: null,
    toStatus: lifecycle,
    reason: 'ingest',
    metadata: { matchState: persistedState },
  });

  if (topupId) {
    observeMetric('float.topup.matched');
    return { id, matchState: 'matched', topupId };
  }

  observeMetric('settlement.suspense');
  observeMetric('float.topup.unmatched');
  return { id, matchState: persistedState };
}

export async function ingestBankDepositPg(
  database: Db,
  input: BankDepositInput,
): Promise<{ id: string; matchState: BankMatchState; topupId?: string }> {
  if (isPoolClient(database)) {
    return ingestBankDepositLocked(database, input);
  }
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    const result = await ingestBankDepositLocked(client, input);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
