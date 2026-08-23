import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import type { Cents } from '../money.js';
import type { FeeComponent } from './feeEnginePg.js';

type Db = Pool | PoolClient;

export type FeeLifecycleState = 'accrued' | 'earned' | 'reversed' | 'swept';

export async function recordFeeLifecyclePg(
  database: Db,
  input: {
    sourceType: string;
    sourceId: string;
    component: FeeComponent;
    amountCents: Cents;
    state: FeeLifecycleState;
    journalTransactionId?: string;
  },
): Promise<void> {
  if (input.amountCents <= 0n) return;
  await database.query(
    `INSERT INTO fee_lifecycle_events
       (id, source_type, source_id, component, amount_cents, state, journal_transaction_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      randomUUID(),
      input.sourceType,
      input.sourceId,
      input.component,
      input.amountCents.toString(),
      input.state,
      input.journalTransactionId ?? null,
    ],
  );
}

export async function latestFeeLifecycleStatePg(
  database: Db,
  sourceType: string,
  sourceId: string,
  component: FeeComponent,
): Promise<FeeLifecycleState | null> {
  const row = await database.query<{ state: FeeLifecycleState }>(
    `SELECT state FROM fee_lifecycle_events
      WHERE source_type = $1 AND source_id = $2 AND component = $3
      ORDER BY created_at DESC LIMIT 1`,
    [sourceType, sourceId, component],
  );
  return row.rows[0]?.state ?? null;
}

/** Platform Cash Send fees become sweepable only after the voucher is collected. */
export function platformFeeSweepable(input: {
  voucherStatus: string;
  component: FeeComponent;
}): boolean {
  return input.component === 'platform' && input.voucherStatus === 'collected';
}
