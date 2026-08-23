import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { parseIntegerCents, type Cents } from '../money.js';
import { evaluateTransactionRiskPg } from './riskPg.js';
import { generateMerchantFloatReference } from './floatReference.js';
import { getEscrowWalletIdForPoolPg } from './escrowPg.js';
import {
  assertWalletKindPair,
  ensureMerchantFloatWalletPg,
  getMerchantFloatWalletPg,
} from './walletKindsPg.js';
import { postBetweenWalletsPg } from './walletPostingPg.js';

type Db = Pool | PoolClient;

export async function requestFloatTopupPg(
  database: Db,
  input: {
    merchantUserId: string;
    merchantId?: string;
    amountCents: Cents;
    currency?: string;
    poolId?: string;
    requestId: string;
    correlationId: string;
    deviceId?: string;
    ip?: string;
  },
): Promise<{ id: string; merchantReference: string; state: string }> {
  const amount = parseIntegerCents(input.amountCents);
  const risk = await evaluateTransactionRiskPg(database, {
    eventType: 'transfer',
    actorUserId: input.merchantUserId,
    amountCents: amount,
    financialReference: `FLOAT-TOP-${randomUUID()}`,
    deviceId: input.deviceId,
    ip: input.ip,
    requestId: input.requestId,
    correlationId: input.correlationId,
  });
  if (risk.decision === 'block') {
    throw Object.assign(new Error('Float top-up declined by risk controls'), {
      status: 403,
      code: 'RISK_BLOCKED',
    });
  }
  if (risk.decision === 'hold') {
    throw Object.assign(new Error('Float top-up held for review'), {
      status: 202,
      code: 'RISK_HOLD',
    });
  }
  await ensureMerchantFloatWalletPg(
    database,
    input.merchantUserId,
    input.poolId ?? 'ZA',
    input.currency ?? 'ZAR',
  );
  const merchantReference = generateMerchantFloatReference(
    input.merchantId ?? input.merchantUserId,
  );
  const id = randomUUID();
  await database.query(
    `INSERT INTO merchant_float_topups
       (id, merchant_user_id, merchant_id, amount_cents, currency, pool_id,
        merchant_reference, state, requested_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'awaiting_bank_match',$2)
     ON CONFLICT (merchant_reference) DO NOTHING`,
    [
      id,
      input.merchantUserId,
      input.merchantId ?? null,
      amount.toString(),
      input.currency ?? 'ZAR',
      input.poolId ?? 'ZA',
      merchantReference,
    ],
  );
  const row = await database.query<{ id: string; state: string }>(
    `SELECT id, state FROM merchant_float_topups WHERE merchant_reference = $1`,
    [merchantReference],
  );
  return {
    id: row.rows[0]?.id ?? id,
    merchantReference,
    state: row.rows[0]?.state ?? 'awaiting_bank_match',
  };
}

/**
 * Credits merchant float only after a matched bank deposit. Never credits on a
 * merchant claim that an EFT was made.
 */
export async function creditMatchedFloatTopupPg(
  client: PoolClient,
  input: { topupId: string; actorId: string },
): Promise<{ journalTransactionId: string }> {
  const topup = await client.query<{
    id: string;
    merchant_user_id: string;
    amount_cents: string;
    currency: string;
    pool_id: string;
    state: string;
    bank_transaction_id: string | null;
  }>(`SELECT * FROM merchant_float_topups WHERE id = $1 FOR UPDATE`, [input.topupId]);
  const row = topup.rows[0];
  if (!row) throw Object.assign(new Error('Float top-up not found'), { status: 404 });
  if (row.state === 'credited') {
    return { journalTransactionId: '' };
  }
  if (row.state !== 'matched' && row.state !== 'approved') {
    throw Object.assign(new Error('Float top-up has no cleared bank match'), {
      status: 409,
      code: 'FLOAT_TOPUP_NOT_MATCHED',
    });
  }
  if (!row.bank_transaction_id) {
    throw Object.assign(new Error('Bank evidence is required before crediting float'), {
      status: 409,
    });
  }
  const float = await ensureMerchantFloatWalletPg(
    client,
    row.merchant_user_id,
    row.pool_id,
    row.currency,
  );
  const escrowId = await getEscrowWalletIdForPoolPg(client, row.pool_id);
  if (!escrowId) {
    throw Object.assign(new Error('Regional escrow is not available'), { status: 503 });
  }
  assertWalletKindPair('system_escrow', float.wallet_kind, 'float_credit');
  const posted = await postBetweenWalletsPg(client, {
    fromWalletId: escrowId,
    toWalletId: float.id,
    amountCents: parseIntegerCents(row.amount_cents),
    type: 'float_topup',
    referencePrefix: 'FLT',
    description: `Matched float top-up ${row.id}`,
    actorId: input.actorId,
  });
  await client.query(
    `UPDATE merchant_float_topups
        SET state = 'credited', journal_transaction_id = $2, approved_by = $3,
            updated_at = clock_timestamp()
      WHERE id = $1`,
    [row.id, posted.transactionId, input.actorId],
  );
  return { journalTransactionId: posted.transactionId };
}

export async function requestFloatWithdrawalPg(
  database: Db,
  input: {
    merchantUserId: string;
    amountCents: Cents;
    settlementAccountId?: string;
    requestId: string;
    correlationId: string;
    deviceId?: string;
    ip?: string;
  },
): Promise<{ id: string; state: string; simulation: true }> {
  const amount = parseIntegerCents(input.amountCents);
  const risk = await evaluateTransactionRiskPg(database, {
    eventType: 'cash_out',
    actorUserId: input.merchantUserId,
    amountCents: amount,
    financialReference: `FLOAT-WD-${randomUUID()}`,
    deviceId: input.deviceId,
    ip: input.ip,
    requestId: input.requestId,
    correlationId: input.correlationId,
  });
  if (risk.decision === 'block') {
    throw Object.assign(new Error('Float withdrawal declined by risk controls'), {
      status: 403,
      code: 'RISK_BLOCKED',
    });
  }
  if (risk.decision === 'hold') {
    throw Object.assign(new Error('Float withdrawal held for review'), {
      status: 202,
      code: 'RISK_HOLD',
    });
  }
  const float = await getMerchantFloatWalletPg(database, input.merchantUserId);
  if (!float) throw Object.assign(new Error('Merchant float wallet missing'), { status: 400 });
  const limits = await database.query<{
    payout_limit_cents: string;
    suspended: boolean;
  }>(`SELECT payout_limit_cents, suspended FROM merchant_float_limits WHERE merchant_user_id = $1`, [
    input.merchantUserId,
  ]);
  if (limits.rows[0]?.suspended) {
    throw Object.assign(new Error('Float movement is suspended'), { status: 403 });
  }
  if (limits.rows[0] && amount > BigInt(limits.rows[0].payout_limit_cents)) {
    throw Object.assign(new Error('Withdrawal exceeds configured payout limit'), { status: 400 });
  }
  const id = randomUUID();
  await database.query(
    `INSERT INTO merchant_float_withdrawals
       (id, merchant_user_id, amount_cents, currency, pool_id, state,
        settlement_account_id, requested_by, simulation)
     VALUES ($1,$2,$3,$4,$5,'requested',$6,$2,TRUE)`,
    [
      id,
      input.merchantUserId,
      amount.toString(),
      float.currency,
      float.pool_id ?? 'ZA',
      input.settlementAccountId ?? null,
    ],
  );
  return { id, state: 'requested', simulation: true };
}

export async function getFloatHistoryPg(database: Db, merchantUserId: string) {
  const [topups, withdrawals, adjustments] = await Promise.all([
    database.query(
      `SELECT id, amount_cents, merchant_reference, state, created_at
         FROM merchant_float_topups WHERE merchant_user_id = $1
         ORDER BY created_at DESC LIMIT 50`,
      [merchantUserId],
    ),
    database.query(
      `SELECT id, amount_cents, state, simulation, created_at
         FROM merchant_float_withdrawals WHERE merchant_user_id = $1
         ORDER BY created_at DESC LIMIT 50`,
      [merchantUserId],
    ),
    database.query(
      `SELECT id, amount_cents, reason, created_at
         FROM merchant_float_adjustments WHERE merchant_user_id = $1
         ORDER BY created_at DESC LIMIT 50`,
      [merchantUserId],
    ),
  ]);
  return {
    topups: topups.rows,
    withdrawals: withdrawals.rows,
    adjustments: adjustments.rows,
  };
}
