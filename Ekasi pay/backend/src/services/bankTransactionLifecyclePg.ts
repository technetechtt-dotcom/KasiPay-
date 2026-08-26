import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { parseIntegerCents, type Cents } from '../money.js';
import { recordAuditEventPg } from './auditPg.js';
import { postBetweenWalletsPg } from './walletPostingPg.js';
import { assertWalletKindPair, getMerchantFloatWalletPg } from './walletKindsPg.js';
import { getEscrowWalletIdForPoolPg } from './escrowPg.js';

type Db = Pool | PoolClient;

export const BANK_LIFECYCLE_STATUSES = [
  'received',
  'pending',
  'posted',
  'settled',
  'reversed',
  'rejected',
] as const;

export type BankLifecycleStatus = (typeof BANK_LIFECYCLE_STATUSES)[number];

const ALLOWED: Record<BankLifecycleStatus, BankLifecycleStatus[]> = {
  received: ['pending', 'posted', 'settled', 'rejected', 'reversed'],
  pending: ['posted', 'settled', 'rejected', 'reversed'],
  posted: ['settled', 'rejected', 'reversed'],
  settled: ['reversed'],
  reversed: [],
  rejected: [],
};

export function canTransitionBankLifecycle(
  from: BankLifecycleStatus,
  to: BankLifecycleStatus,
): boolean {
  return ALLOWED[from]?.includes(to) === true;
}

export async function recordBankLifecycleEventPg(
  database: Db,
  input: {
    bankTransactionId: string;
    fromStatus: string | null;
    toStatus: string;
    actorId?: string;
    reason?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await database.query(
    `INSERT INTO bank_transaction_events
       (id, bank_transaction_id, from_status, to_status, actor_id, reason, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [
      randomUUID(),
      input.bankTransactionId,
      input.fromStatus,
      input.toStatus,
      input.actorId ?? null,
      input.reason ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
}

export async function settleBankTransactionPg(
  client: PoolClient,
  input: { bankTransactionId: string; actorId: string; settlementDate?: string },
): Promise<{ lifecycleStatus: BankLifecycleStatus }> {
  const row = await client.query<{
    lifecycle_status: BankLifecycleStatus;
    direction: string;
  }>(
    `SELECT lifecycle_status, direction FROM bank_transactions WHERE id = $1 FOR UPDATE`,
    [input.bankTransactionId],
  );
  const current = row.rows[0];
  if (!current) throw Object.assign(new Error('Bank transaction not found'), { status: 404 });
  if (current.lifecycle_status === 'settled') {
    return { lifecycleStatus: 'settled' };
  }
  if (!canTransitionBankLifecycle(current.lifecycle_status, 'settled')) {
    throw Object.assign(
      new Error(`Cannot settle a ${current.lifecycle_status} bank transaction`),
      { status: 409, code: 'BANK_LIFECYCLE_INVALID' },
    );
  }
  if (current.direction !== 'credit') {
    throw Object.assign(new Error('Only client-funds credits can be settled for float'), {
      status: 409,
      code: 'BANK_CREDIT_REQUIRED',
    });
  }
  await client.query(
    `UPDATE bank_transactions
        SET lifecycle_status = 'settled',
            settled_at = clock_timestamp(),
            settlement_date = COALESCE($2::date, CURRENT_DATE),
            posted_at = COALESCE(posted_at, clock_timestamp())
      WHERE id = $1`,
    [input.bankTransactionId, input.settlementDate ?? null],
  );
  await recordBankLifecycleEventPg(client, {
    bankTransactionId: input.bankTransactionId,
    fromStatus: current.lifecycle_status,
    toStatus: 'settled',
    actorId: input.actorId,
    reason: 'ops_settle',
  });
  return { lifecycleStatus: 'settled' };
}

export async function freezeMerchantFloatPg(
  database: Db,
  merchantUserId: string,
  reason: string,
): Promise<void> {
  await database.query(
    `INSERT INTO merchant_float_limits (merchant_user_id, suspended, updated_at)
     VALUES ($1, TRUE, clock_timestamp())
     ON CONFLICT (merchant_user_id)
     DO UPDATE SET suspended = TRUE, updated_at = clock_timestamp()`,
    [merchantUserId],
  );
  await database.query(
    `UPDATE payout_agents SET float_suspended = TRUE, updated_at = clock_timestamp()
      WHERE merchant_id = $1`,
    [merchantUserId],
  );
  await recordAuditEventPg(database, {
    type: 'merchant_float.frozen',
    message: reason,
    actorType: 'operator',
    targetType: 'user',
    targetId: merchantUserId,
    reason,
  });
}

/**
 * Bank reversal after float was issued: freeze, claw back what we can,
 * and open a debt/suspense case for any remainder.
 */
export async function reverseBankTransactionPg(
  client: PoolClient,
  input: {
    bankTransactionId: string;
    actorId: string;
    reversalReference: string;
    reason: string;
  },
): Promise<{
  lifecycleStatus: 'reversed';
  frozen: boolean;
  clawedBackCents: string;
  debtCents: string;
}> {
  const row = await client.query<{
    id: string;
    lifecycle_status: BankLifecycleStatus;
    amount_cents: string;
    matched_topup_id: string | null;
    currency: string;
  }>(
    `SELECT id, lifecycle_status, amount_cents, matched_topup_id, currency
       FROM bank_transactions WHERE id = $1 FOR UPDATE`,
    [input.bankTransactionId],
  );
  const tx = row.rows[0];
  if (!tx) throw Object.assign(new Error('Bank transaction not found'), { status: 404 });
  if (tx.lifecycle_status === 'reversed') {
    return {
      lifecycleStatus: 'reversed',
      frozen: true,
      clawedBackCents: '0',
      debtCents: '0',
    };
  }
  if (!canTransitionBankLifecycle(tx.lifecycle_status, 'reversed')) {
    throw Object.assign(
      new Error(`Cannot reverse a ${tx.lifecycle_status} bank transaction`),
      { status: 409, code: 'BANK_LIFECYCLE_INVALID' },
    );
  }

  let clawed = 0n as Cents;
  let debt = 0n as Cents;
  let merchantUserId: string | null = null;

  if (tx.matched_topup_id) {
    const topup = await client.query<{
      id: string;
      merchant_user_id: string;
      state: string;
      amount_cents: string;
      pool_id: string;
    }>(
      `SELECT id, merchant_user_id, state, amount_cents, pool_id
         FROM merchant_float_topups WHERE id = $1 FOR UPDATE`,
      [tx.matched_topup_id],
    );
    const credited = topup.rows[0];
    if (credited) {
      merchantUserId = credited.merchant_user_id;
      await freezeMerchantFloatPg(client, credited.merchant_user_id, input.reason);
      if (credited.state === 'credited') {
        const float = await getMerchantFloatWalletPg(client, credited.merchant_user_id);
        const escrowId = await getEscrowWalletIdForPoolPg(client, credited.pool_id);
        const amount = parseIntegerCents(credited.amount_cents);
        const available = parseIntegerCents(float?.balance_cents ?? '0', { allowZero: true });
        const clawback = (available < amount ? available : amount) as Cents;
        if (float && escrowId && clawback > 0n) {
          assertWalletKindPair(float.wallet_kind, 'system_escrow', 'float_debit');
          await postBetweenWalletsPg(client, {
            fromWalletId: float.id,
            toWalletId: escrowId,
            amountCents: clawback,
            type: 'reversal',
            referencePrefix: 'FLR',
            description: `Bank reversal ${input.reversalReference}`,
            actorId: input.actorId,
          });
          clawed = clawback;
        }
        debt = (amount - clawback) as Cents;
        if (debt > 0n) {
          await client.query(
            `INSERT INTO merchant_float_debts
               (id, merchant_user_id, bank_transaction_id, amount_cents, state, reason)
             VALUES ($1,$2,$3,$4,'frozen',$5)`,
            [
              randomUUID(),
              credited.merchant_user_id,
              tx.id,
              debt.toString(),
              input.reason,
            ],
          );
        }
      }
      await client.query(
        `UPDATE merchant_float_topups
            SET state = 'reversed', updated_at = clock_timestamp()
          WHERE id = $1`,
        [credited.id],
      );
    }
  }

  await client.query(
    `UPDATE bank_transactions
        SET lifecycle_status = 'reversed',
            reversed_at = clock_timestamp(),
            match_state = 'suspense',
            reconciliation_status = 'investigating'
      WHERE id = $1`,
    [tx.id],
  );
  await recordBankLifecycleEventPg(client, {
    bankTransactionId: tx.id,
    fromStatus: tx.lifecycle_status,
    toStatus: 'reversed',
    actorId: input.actorId,
    reason: input.reason,
    metadata: { reversalReference: input.reversalReference, merchantUserId },
  });
  await recordAuditEventPg(client, {
    type: 'bank_transaction.reversed',
    message: input.reason,
    actorType: 'operator',
    actorId: input.actorId,
    targetType: 'bank_transaction',
    targetId: tx.id,
    financialReference: input.reversalReference,
    safeMetadata: {
      clawedBackCents: clawed.toString(),
      debtCents: debt.toString(),
    },
  });
  return {
    lifecycleStatus: 'reversed',
    frozen: Boolean(merchantUserId),
    clawedBackCents: clawed.toString(),
    debtCents: debt.toString(),
  };
}

export async function listBankTransactionHistoryPg(database: Db, bankTransactionId: string) {
  const tx = await database.query(`SELECT * FROM bank_transactions WHERE id = $1`, [
    bankTransactionId,
  ]);
  const events = await database.query(
    `SELECT * FROM bank_transaction_events
      WHERE bank_transaction_id = $1 ORDER BY created_at ASC`,
    [bankTransactionId],
  );
  return { transaction: tx.rows[0] ?? null, events: events.rows };
}
