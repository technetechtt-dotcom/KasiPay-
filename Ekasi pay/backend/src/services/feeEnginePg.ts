import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { parseIntegerCents, type Cents } from '../money.js';

type DbClient = Pool | PoolClient;
export type FeeComponent = 'platform' | 'provider' | 'tax' | 'agent' | 'merchant';

export type FeeTier = {
  id: string;
  minCents: Cents;
  maxCents: Cents | null;
  flatCents: Cents;
  rateBasisPoints: number;
  minFeeCents: Cents;
  maxFeeCents: Cents | null;
  allocations: Partial<Record<FeeComponent, number>>;
};

export function calculateFeeCents(
  principalCents: Cents,
  tier: FeeTier,
): { totalFeeCents: Cents; components: Record<FeeComponent, Cents> } {
  const principal = parseIntegerCents(principalCents);
  if (principal < tier.minCents || (tier.maxCents !== null && principal > tier.maxCents)) {
    throw new Error('Principal does not belong to selected fee tier');
  }
  const proportional = (principal * BigInt(tier.rateBasisPoints) + 5_000n) / 10_000n;
  let total = tier.flatCents + proportional;
  if (total < tier.minFeeCents) total = tier.minFeeCents;
  if (tier.maxFeeCents !== null && total > tier.maxFeeCents) total = tier.maxFeeCents;

  const entries = Object.entries(tier.allocations) as [FeeComponent, number][];
  const allocationTotal = entries.reduce((sum, [, basisPoints]) => sum + basisPoints, 0);
  if (allocationTotal !== 10_000) throw new Error('Fee allocations must total 10000 basis points');
  const components: Record<FeeComponent, Cents> = {
    platform: 0n as Cents,
    provider: 0n as Cents,
    tax: 0n as Cents,
    agent: 0n as Cents,
    merchant: 0n as Cents,
  };
  let allocated = 0n;
  entries.forEach(([component, basisPoints], index) => {
    const amount =
      index === entries.length - 1
        ? total - allocated
        : (total * BigInt(basisPoints)) / 10_000n;
    components[component] = amount as Cents;
    allocated += amount;
  });
  return { totalFeeCents: total as Cents, components };
}

export async function resolveFeeSchedulePg(
  database: DbClient,
  input: { product: string; currency: string; principalCents: Cents; at?: Date },
): Promise<{ scheduleId: string; tier: FeeTier }> {
  const result = await database.query<{
    schedule_id: string;
    tier_id: string;
    min_cents: string;
    max_cents: string | null;
    flat_cents: string;
    rate_basis_points: number;
    min_fee_cents: string;
    max_fee_cents: string | null;
    allocations: Partial<Record<FeeComponent, number>>;
  }>(
    `SELECT s.id AS schedule_id, t.id AS tier_id, t.*
       FROM fee_schedules s JOIN fee_schedule_tiers t ON t.fee_schedule_id = s.id
      WHERE s.product = $1 AND s.currency = $2 AND s.state = 'published'
        AND s.effective_from <= $3
        AND (s.effective_to IS NULL OR s.effective_to > $3)
        AND t.min_cents <= $4 AND (t.max_cents IS NULL OR t.max_cents >= $4)
      ORDER BY s.effective_from DESC, s.version DESC, t.min_cents DESC LIMIT 1`,
    [
      input.product,
      input.currency,
      (input.at ?? new Date()).toISOString(),
      input.principalCents.toString(),
    ],
  );
  const row = result.rows[0];
  if (!row) throw Object.assign(new Error(`No active fee schedule for ${input.product}`), { status: 503 });
  return {
    scheduleId: row.schedule_id,
    tier: {
      id: row.tier_id,
      minCents: BigInt(row.min_cents) as Cents,
      maxCents: row.max_cents === null ? null : (BigInt(row.max_cents) as Cents),
      flatCents: BigInt(row.flat_cents) as Cents,
      rateBasisPoints: row.rate_basis_points,
      minFeeCents: BigInt(row.min_fee_cents) as Cents,
      maxFeeCents: row.max_fee_cents === null ? null : (BigInt(row.max_fee_cents) as Cents),
      allocations: row.allocations,
    },
  };
}

export function assertCommissionParties(input: {
  payerUserId?: string;
  agentUserId?: string;
  merchantUserId?: string;
}): void {
  const values = [input.payerUserId, input.agentUserId, input.merchantUserId].filter(
    (value): value is string => Boolean(value),
  );
  if (new Set(values).size !== values.length) {
    throw new Error('Self or circular commission is not permitted');
  }
}

export async function postFeeAccrualPg(
  database: DbClient,
  input: {
    sourceWalletId: string;
    sourceReference: string;
    currency: string;
    components: Record<FeeComponent, Cents>;
    actorId?: string;
  },
): Promise<{ transactionId: string; reference: string }> {
  const nonZero = (Object.entries(input.components) as [FeeComponent, Cents][])
    .filter(([, amount]) => amount > 0n);
  const total = nonZero.reduce((sum, [, amount]) => sum + amount, 0n);
  if (total <= 0n) throw new Error('Fee accrual must be positive');
  const source = await database.query<{ id: string; pool_id: string }>(
    `SELECT id,pool_id FROM ledger_accounts WHERE wallet_id = $1`,
    [input.sourceWalletId],
  );
  if (!source.rows[0]) throw new Error('Source wallet ledger account is missing');
  const transactionId = randomUUID();
  const batchId = randomUUID();
  const reference = `FEE-${input.sourceReference}`;
  await database.query(
    `INSERT INTO posting_batches(id,source,actor_id,state)
     VALUES ($1,'fee_accrual',$2,'authorized')`,
    [batchId, input.actorId ?? null],
  );
  await database.query(
    `INSERT INTO journal_transactions
       (id,batch_id,reference,transaction_type,description,currency,pool_id,
        state,effective_at,posted_at,metadata)
     VALUES ($1,$2,$3,'fee_accrual',$4,$5,$6,'authorized',
             clock_timestamp(),clock_timestamp(),$7::jsonb)`,
    [
      transactionId,
      batchId,
      reference,
      `Fee accrual for ${input.sourceReference}`,
      input.currency,
      source.rows[0].pool_id,
      JSON.stringify({ sourceReference: input.sourceReference }),
    ],
  );
  await database.query(
    `INSERT INTO journal_entries(id,transaction_id,account_id,side,amount_cents,currency)
     VALUES ($1,$2,$3,'debit',$4,$5)`,
    [randomUUID(), transactionId, source.rows[0].id, total.toString(), input.currency],
  );
  const accounts: Record<FeeComponent, string> = {
    platform: 'phase6-platform-liability-zar',
    provider: 'phase6-provider-liability-zar',
    tax: 'phase6-tax-liability-zar',
    agent: 'phase6-agent-liability-zar',
    merchant: 'phase6-merchant-liability-zar',
  };
  for (const [component, amount] of nonZero) {
    await database.query(
      `INSERT INTO journal_entries(id,transaction_id,account_id,side,amount_cents,currency)
       VALUES ($1,$2,$3,'credit',$4,$5)`,
      [randomUUID(), transactionId, accounts[component], amount.toString(), input.currency],
    );
  }
  await database.query(
    `UPDATE account_balance_projections
        SET available_cents = available_cents - $1, version = version + 1,
            updated_at = clock_timestamp()
      WHERE account_id = $2 AND available_cents >= $1`,
    [total.toString(), source.rows[0].id],
  );
  await database.query(
    `UPDATE wallets SET balance_cents = balance_cents - $1 WHERE id = $2`,
    [total.toString(), input.sourceWalletId],
  );
  for (const [component, amount] of nonZero) {
    await database.query(
      `UPDATE account_balance_projections
          SET available_cents = available_cents + $1, version = version + 1,
              updated_at = clock_timestamp()
        WHERE account_id = $2`,
      [amount.toString(), accounts[component]],
    );
  }
  await database.query(
    `UPDATE journal_transactions SET state = 'posted' WHERE id = $1;
     UPDATE posting_batches SET state = 'posted',posted_at = clock_timestamp() WHERE id = $2`,
    [transactionId, batchId],
  );
  return { transactionId, reference };
}

export async function recordFeeAssessmentPg(
  database: DbClient,
  input: {
    scheduleId: string;
    tier: FeeTier;
    sourceType: string;
    sourceId: string;
    principalCents: Cents;
    currency: string;
    journalTransactionId: string;
    beneficiaries?: Partial<Record<'agent' | 'merchant', string>>;
  },
): Promise<{ assessmentId: string; totalFeeCents: Cents }> {
  assertCommissionParties({
    agentUserId: input.beneficiaries?.agent,
    merchantUserId: input.beneficiaries?.merchant,
  });
  const calculated = calculateFeeCents(input.principalCents, input.tier);
  const assessmentId = randomUUID();
  await database.query(
    `INSERT INTO fee_assessments
       (id, fee_schedule_id, fee_tier_id, source_type, source_id, principal_cents,
        total_fee_cents, currency, journal_transaction_id, calculation)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
    [
      assessmentId,
      input.scheduleId,
      input.tier.id,
      input.sourceType,
      input.sourceId,
      input.principalCents.toString(),
      calculated.totalFeeCents.toString(),
      input.currency,
      input.journalTransactionId,
      JSON.stringify({
        flatCents: input.tier.flatCents.toString(),
        rateBasisPoints: input.tier.rateBasisPoints,
        minFeeCents: input.tier.minFeeCents.toString(),
        maxFeeCents: input.tier.maxFeeCents?.toString() ?? null,
      }),
    ],
  );
  const account: Record<FeeComponent, string> = {
    platform: 'phase6-platform-liability-zar',
    provider: 'phase6-provider-liability-zar',
    tax: 'phase6-tax-liability-zar',
    agent: 'phase6-agent-liability-zar',
    merchant: 'phase6-merchant-liability-zar',
  };
  for (const [component, amount] of Object.entries(calculated.components) as [FeeComponent, Cents][]) {
    if (amount === 0n) continue;
    await database.query(
      `INSERT INTO fee_assessment_components
         (id, assessment_id, component, amount_cents, liability_account_id, beneficiary_user_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        randomUUID(),
        assessmentId,
        component,
        amount.toString(),
        account[component],
        component === 'agent' || component === 'merchant'
          ? input.beneficiaries?.[component] ?? null
          : null,
      ],
    );
  }
  return { assessmentId, totalFeeCents: calculated.totalFeeCents };
}

export async function reverseFeeAccrualPg(
  database: DbClient,
  input: { sourceType: string; sourceId: string; actorId?: string },
): Promise<string | null> {
  const found = await database.query<{
    transaction_id: string;
    currency: string;
    pool_id: string;
    source_account_id: string;
    wallet_id: string;
    total_cents: string;
  }>(
    `SELECT a.journal_transaction_id AS transaction_id, j.currency, j.pool_id,
            e.account_id AS source_account_id, l.wallet_id,
            e.amount_cents::text AS total_cents
       FROM fee_assessments a
       JOIN journal_transactions j ON j.id = a.journal_transaction_id
       JOIN journal_entries e ON e.transaction_id = j.id AND e.side = 'debit'
       JOIN ledger_accounts l ON l.id = e.account_id
      WHERE a.source_type = $1 AND a.source_id = $2 AND a.reversal_of_id IS NULL
      LIMIT 1 FOR UPDATE OF a`,
    [input.sourceType, input.sourceId],
  );
  const row = found.rows[0];
  if (!row) return null;
  const existing = await database.query<{ id: string }>(
    `SELECT id FROM journal_transactions
      WHERE original_transaction_id = $1 AND transaction_type = 'fee_clawback'`,
    [row.transaction_id],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const credits = await database.query<{ account_id: string; amount_cents: string }>(
    `SELECT account_id,amount_cents::text FROM journal_entries
      WHERE transaction_id = $1 AND side = 'credit'`,
    [row.transaction_id],
  );
  const transactionId = randomUUID();
  const batchId = randomUUID();
  await database.query(
    `INSERT INTO posting_batches(id,source,actor_id,state)
     VALUES ($1,'fee_clawback',$2,'authorized')`,
    [batchId, input.actorId ?? null],
  );
  await database.query(
    `INSERT INTO journal_transactions
       (id,batch_id,reference,transaction_type,description,currency,pool_id,state,
        original_transaction_id,reversal_kind,effective_at,posted_at)
     VALUES ($1,$2,$3,'fee_clawback',$4,$5,$6,'authorized',$7,'refund',
             clock_timestamp(),clock_timestamp())`,
    [
      transactionId,
      batchId,
      `CLAW-${row.transaction_id}`,
      `Fee clawback for ${input.sourceType}/${input.sourceId}`,
      row.currency,
      row.pool_id,
      row.transaction_id,
    ],
  );
  for (const credit of credits.rows) {
    await database.query(
      `INSERT INTO journal_entries(id,transaction_id,account_id,side,amount_cents,currency)
       VALUES ($1,$2,$3,'debit',$4,$5)`,
      [randomUUID(), transactionId, credit.account_id, credit.amount_cents, row.currency],
    );
    await database.query(
      `UPDATE account_balance_projections
          SET available_cents = available_cents - $1,version = version + 1,
              updated_at = clock_timestamp() WHERE account_id = $2`,
      [credit.amount_cents, credit.account_id],
    );
  }
  await database.query(
    `INSERT INTO journal_entries(id,transaction_id,account_id,side,amount_cents,currency)
     VALUES ($1,$2,$3,'credit',$4,$5)`,
    [randomUUID(), transactionId, row.source_account_id, row.total_cents, row.currency],
  );
  await database.query(
    `UPDATE account_balance_projections
        SET available_cents = available_cents + $1,version = version + 1,
            updated_at = clock_timestamp() WHERE account_id = $2`,
    [row.total_cents, row.source_account_id],
  );
  if (row.wallet_id) {
    await database.query(
      `UPDATE wallets SET balance_cents = balance_cents + $1 WHERE id = $2`,
      [row.total_cents, row.wallet_id],
    );
  }
  await database.query(
    `UPDATE journal_transactions SET state = 'posted' WHERE id = $1;
     UPDATE posting_batches SET state = 'posted',posted_at = clock_timestamp() WHERE id = $2`,
    [transactionId, batchId],
  );
  return transactionId;
}
