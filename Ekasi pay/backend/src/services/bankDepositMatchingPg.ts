import { createHash, randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { parseIntegerCents, type Cents } from '../money.js';
import { observeMetric } from '../observability.js';

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
};

export type BankMatchState = 'matched' | 'partial' | 'duplicate' | 'unmatched' | 'suspense';

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
}): BankMatchState {
  if (input.alreadyMatched) return 'duplicate';
  if (input.exactMatches === 1) return 'matched';
  if (input.exactMatches > 1) return 'duplicate';
  if (input.amountMatches >= 1) return 'partial';
  return 'unmatched';
}

export async function ingestBankDepositPg(
  database: Db,
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

  const exact = input.merchantReference
    ? await database.query<{ id: string; amount_cents: string; state: string }>(
        `SELECT id, amount_cents, state FROM merchant_float_topups
          WHERE merchant_reference = $1 AND currency = $2
          FOR UPDATE`,
        [input.merchantReference, input.currency],
      )
    : { rows: [] as Array<{ id: string; amount_cents: string; state: string }> };

  const amountOnly = input.merchantReference
    ? await database.query<{ id: string }>(
        `SELECT id FROM merchant_float_topups
          WHERE currency = $1 AND amount_cents = $2
            AND merchant_reference <> $3
            AND state IN ('requested','awaiting_bank_match')`,
        [input.currency, amount.toString(), input.merchantReference],
      )
    : { rows: [] };

  const credited = exact.rows.filter((row) => ['matched', 'approved', 'credited'].includes(row.state));
  const pending = exact.rows.filter((row) =>
    ['requested', 'awaiting_bank_match'].includes(row.state),
  );
  const exactAmount = pending.filter((row) => BigInt(row.amount_cents) === amount);
  const matchState = classifyBankDepositMatch({
    exactMatches: exactAmount.length,
    amountMatches: pending.length - exactAmount.length + amountOnly.rows.length,
    alreadyMatched: credited.length > 0,
  });

  const id = randomUUID();
  const topupId = matchState === 'matched' ? exactAmount[0]?.id : undefined;
  await database.query(
    `INSERT INTO bank_transactions
       (id, bank_reference, merchant_reference, amount_cents, currency, direction,
        value_date, source_account_fingerprint, destination_account, raw_hash,
        statement_file_id, match_state, matched_topup_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
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
      matchState === 'unmatched' || matchState === 'partial' ? 'suspense' : matchState,
      topupId ?? null,
    ],
  );

  if (matchState === 'matched' && topupId) {
    await database.query(
      `UPDATE merchant_float_topups
          SET state = 'matched', bank_transaction_id = $2, updated_at = clock_timestamp()
        WHERE id = $1 AND state IN ('requested','awaiting_bank_match')`,
      [topupId, id],
    );
    observeMetric('float.topup.matched');
    return { id, matchState, topupId };
  }

  observeMetric('settlement.suspense');
  observeMetric('float.topup.unmatched');
  return {
    id,
    matchState: matchState === 'unmatched' || matchState === 'partial' ? 'suspense' : matchState,
  };
}
