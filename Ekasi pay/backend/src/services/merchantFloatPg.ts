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
import { isApprovedClientFundsDestinationPg } from './clientFundsAccountsPg.js';
import { recognizeClientFundsBankCreditPg } from './clientFundsRecognitionPg.js';
import { postBetweenWalletsPg } from './walletPostingPg.js';
import { lockApprovedRequest, markApprovalExecuted } from '../security/approvalsPg.js';
import { freezeMerchantFloatPg } from './bankTransactionLifecyclePg.js';

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
  const limits = await database.query<{
    suspended: boolean;
    daily_cash_in_limit_cents: string;
    monthly_cash_in_limit_cents: string;
    exposure_limit_cents: string;
  }>(
    `SELECT suspended, daily_cash_in_limit_cents, monthly_cash_in_limit_cents, exposure_limit_cents
       FROM merchant_float_limits WHERE merchant_user_id = $1`,
    [input.merchantUserId],
  );
  if (limits.rows[0]?.suspended) {
    throw Object.assign(new Error('Float movement is suspended'), {
      status: 403,
      code: 'FLOAT_FROZEN',
    });
  }
  const used = await database.query<{ daily: string; monthly: string }>(
    `SELECT
       COALESCE(sum(amount_cents) FILTER (WHERE created_at >= current_date),0)::text AS daily,
       COALESCE(sum(amount_cents) FILTER (
         WHERE created_at >= date_trunc('month', current_date)
       ),0)::text AS monthly
       FROM merchant_float_topups
      WHERE merchant_user_id = $1 AND state <> 'rejected'`,
    [input.merchantUserId],
  );
  if (limits.rows[0]) {
    const dailyCap = BigInt(limits.rows[0].daily_cash_in_limit_cents);
    const monthlyCap = BigInt(limits.rows[0].monthly_cash_in_limit_cents);
    if (BigInt(used.rows[0]?.daily ?? '0') + amount > dailyCap) {
      throw Object.assign(new Error('Daily cash-in limit exceeded'), {
        status: 400,
        code: 'FLOAT_DAILY_CASH_IN_LIMIT',
      });
    }
    if (BigInt(used.rows[0]?.monthly ?? '0') + amount > monthlyCap) {
      throw Object.assign(new Error('Monthly cash-in limit exceeded'), {
        status: 400,
        code: 'FLOAT_MONTHLY_CASH_IN_LIMIT',
      });
    }
  }
  const floatWallet = await ensureMerchantFloatWalletPg(
    database,
    input.merchantUserId,
    input.poolId ?? 'ZA',
    input.currency ?? 'ZAR',
  );
  if (limits.rows[0]) {
    const pending = await database.query<{ cents: string }>(
      `SELECT COALESCE(sum(amount_cents),0)::text AS cents
         FROM merchant_float_topups
        WHERE merchant_user_id = $1 AND state IN ('requested','awaiting_bank_match','matched','approved')`,
      [input.merchantUserId],
    );
    const exposure =
      parseIntegerCents(floatWallet.balance_cents ?? '0', { allowZero: true }) +
      BigInt(pending.rows[0]?.cents ?? '0') +
      amount;
    if (exposure > BigInt(limits.rows[0].exposure_limit_cents)) {
      throw Object.assign(new Error('Agent exposure limit exceeded'), {
        status: 400,
        code: 'FLOAT_EXPOSURE_LIMIT',
      });
    }
  }
  const merchantReference = generateMerchantFloatReference(
    input.merchantId ?? input.merchantUserId,
  );
  const id = randomUUID();
  await database.query(
    `INSERT INTO merchant_float_topups
       (id, merchant_user_id, merchant_id, amount_cents, currency, pool_id,
        merchant_reference, state, requested_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'awaiting_bank_match',$2)`,
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
  return {
    id,
    merchantReference,
    state: 'awaiting_bank_match',
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
    bank_recognition_journal_id: string | null;
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
  const bankTx = await client.query<{
    id: string;
    direction: string;
    destination_account: string | null;
    matched_topup_id: string | null;
    currency: string;
    lifecycle_status: string;
  }>(
    `SELECT id, direction, destination_account, matched_topup_id, currency, lifecycle_status
       FROM bank_transactions WHERE id = $1 FOR UPDATE`,
    [row.bank_transaction_id],
  );
  const evidence = bankTx.rows[0];
  if (!evidence || evidence.direction !== 'credit') {
    throw Object.assign(new Error('Only a client-funds bank credit can back a float top-up'), {
      status: 409,
      code: 'BANK_CREDIT_REQUIRED',
    });
  }
  if (evidence.lifecycle_status !== 'settled') {
    throw Object.assign(
      new Error('Merchant float is credited only after the bank transaction is settled'),
      { status: 409, code: 'BANK_NOT_SETTLED' },
    );
  }
  if (evidence.matched_topup_id && evidence.matched_topup_id !== row.id) {
    throw Object.assign(new Error('This bank transaction already backs another float top-up'), {
      status: 409,
      code: 'BANK_TX_ALREADY_USED',
    });
  }
  const clientFunds = await isApprovedClientFundsDestinationPg(client, {
    destinationAccount: evidence.destination_account,
    currency: evidence.currency,
    poolId: row.pool_id,
  });
  if (!clientFunds) {
    throw Object.assign(
      new Error('Destination must be an approved client_funds safeguarding account'),
      { status: 409, code: 'CLIENT_FUNDS_DESTINATION_REQUIRED' },
    );
  }
  const claimedBank = await client.query(
    `UPDATE bank_transactions
        SET matched_topup_id = $2
      WHERE id = $1 AND (matched_topup_id IS NULL OR matched_topup_id = $2)`,
    [evidence.id, row.id],
  );
  if (!claimedBank.rowCount) {
    throw Object.assign(new Error('This bank transaction already backs another float top-up'), {
      status: 409,
      code: 'BANK_TX_ALREADY_USED',
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
  let recognitionId = row.bank_recognition_journal_id;
  if (!recognitionId) {
    const recognized = await recognizeClientFundsBankCreditPg(client, {
      escrowWalletId: escrowId,
      amountCents: parseIntegerCents(row.amount_cents),
      currency: row.currency,
      poolId: row.pool_id,
      bankTransactionId: evidence.id,
      actorId: input.actorId,
    });
    recognitionId = recognized.transactionId;
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
            bank_recognition_journal_id = $4, updated_at = clock_timestamp()
      WHERE id = $1`,
    [row.id, posted.transactionId, input.actorId, recognitionId],
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
  const cashOutCap = await database.query<{ cash_out_limit_cents: string }>(
    `SELECT cash_out_limit_cents FROM merchant_float_limits WHERE merchant_user_id = $1`,
    [input.merchantUserId],
  );
  if (cashOutCap.rows[0] && amount > BigInt(cashOutCap.rows[0].cash_out_limit_cents)) {
    throw Object.assign(new Error('Withdrawal exceeds cash-out limit'), {
      status: 400,
      code: 'FLOAT_CASH_OUT_LIMIT',
    });
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
  const pendingTopups = topups.rows.filter((row: { state: string }) =>
    ['requested', 'awaiting_bank_match', 'matched', 'approved'].includes(row.state),
  );
  const clearedTopups = topups.rows.filter((row: { state: string }) => row.state === 'credited');
  const rejectedTopups = topups.rows.filter((row: { state: string }) =>
    ['rejected', 'reversed'].includes(row.state),
  );
  return {
    topups: topups.rows,
    pendingTopups,
    clearedTopups,
    rejectedTopups,
    withdrawals: withdrawals.rows,
    adjustments: adjustments.rows,
  };
}

export async function getFloatAlertsPg(database: Db, merchantUserId: string) {
  const float = await getMerchantFloatWalletPg(database, merchantUserId);
  const limits = await database.query<{
    suspended: boolean;
    float_floor_cents: string;
    exposure_limit_cents: string;
  }>(
    `SELECT suspended, float_floor_cents, exposure_limit_cents
       FROM merchant_float_limits WHERE merchant_user_id = $1`,
    [merchantUserId],
  );
  const unmatched = await database.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM merchant_float_topups
      WHERE merchant_user_id = $1 AND state IN ('requested','awaiting_bank_match')
        AND created_at < clock_timestamp() - interval '24 hours'`,
    [merchantUserId],
  );
  const reversals = await database.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM merchant_float_topups
      WHERE merchant_user_id = $1 AND state = 'reversed'`,
    [merchantUserId],
  );
  const overdue = await database.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM merchant_float_withdrawals
      WHERE merchant_user_id = $1 AND state IN ('requested','approved','submitted','unknown')
        AND created_at < clock_timestamp() - interval '48 hours'`,
    [merchantUserId],
  );
  const balance = parseIntegerCents(float?.balance_cents ?? '0', { allowZero: true });
  const alerts: Array<{ code: string; severity: 'info' | 'warning' | 'critical'; message: string }> =
    [];
  if (limits.rows[0]?.suspended) {
    alerts.push({ code: 'FLOAT_FROZEN', severity: 'critical', message: 'Merchant float is frozen' });
  }
  if (limits.rows[0] && balance < BigInt(limits.rows[0].float_floor_cents)) {
    alerts.push({ code: 'LOW_FLOAT', severity: 'warning', message: 'Float is below the configured floor' });
  }
  if (limits.rows[0] && balance > BigInt(limits.rows[0].exposure_limit_cents)) {
    alerts.push({ code: 'EXCESS_FLOAT', severity: 'warning', message: 'Float exceeds exposure limit' });
  }
  if (Number(unmatched.rows[0]?.n ?? 0) > 0) {
    alerts.push({
      code: 'TOPUP_UNMATCHED',
      severity: 'warning',
      message: 'A top-up has been unmatched for more than 24 hours',
    });
  }
  if (Number(reversals.rows[0]?.n ?? 0) > 0) {
    alerts.push({ code: 'BANK_REVERSAL', severity: 'critical', message: 'A bank-backed top-up was reversed' });
  }
  if (Number(overdue.rows[0]?.n ?? 0) > 0) {
    alerts.push({
      code: 'SETTLEMENT_OVERDUE',
      severity: 'warning',
      message: 'A withdrawal/settlement request is overdue',
    });
  }
  return { alerts, frozen: Boolean(limits.rows[0]?.suspended), balanceCents: balance.toString() };
}

export async function applyFloatAdjustmentPg(
  client: PoolClient,
  input: {
    merchantUserId: string;
    amountCents: Cents;
    reason: string;
    actorId: string;
    approvalRequestId: string;
  },
): Promise<{ id: string; journalTransactionId: string }> {
  const amount = parseIntegerCents(input.amountCents, { allowNegative: true });
  if (amount === 0n) {
    throw Object.assign(new Error('Adjustment amount cannot be zero'), { status: 400 });
  }
  await lockApprovedRequest(client, {
    approvalRequestId: input.approvalRequestId,
    actionType: 'float_adjustment',
    resourceType: 'merchant_float',
    resourceId: input.merchantUserId,
    executorOperatorId: input.actorId,
  });
  const float = await ensureMerchantFloatWalletPg(client, input.merchantUserId);
  const escrowId = await getEscrowWalletIdForPoolPg(client, float.pool_id ?? 'ZA');
  if (!escrowId) {
    throw Object.assign(new Error('Regional escrow is not available'), { status: 503 });
  }
  const fromWalletId = amount > 0n ? escrowId : float.id;
  const toWalletId = amount > 0n ? float.id : escrowId;
  const abs = (amount < 0n ? -amount : amount) as Cents;
  assertWalletKindPair(
    amount > 0n ? 'system_escrow' : float.wallet_kind,
    amount > 0n ? float.wallet_kind : 'system_escrow',
    amount > 0n ? 'float_credit' : 'float_debit',
  );
  const posted = await postBetweenWalletsPg(client, {
    fromWalletId,
    toWalletId,
    amountCents: abs,
    type: 'balance_adjustment',
    referencePrefix: 'FAD',
    description: input.reason,
    actorId: input.actorId,
  });
  const id = randomUUID();
  await client.query(
    `INSERT INTO merchant_float_adjustments
       (id, merchant_user_id, amount_cents, reason, approval_request_id, journal_transaction_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      id,
      input.merchantUserId,
      amount.toString(),
      input.reason,
      input.approvalRequestId,
      posted.transactionId,
      input.actorId,
    ],
  );
  await markApprovalExecuted(client, input.approvalRequestId, input.actorId, input.reason);
  return { id, journalTransactionId: posted.transactionId };
}

export { freezeMerchantFloatPg };
