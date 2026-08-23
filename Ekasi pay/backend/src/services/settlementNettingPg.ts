import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { parseIntegerCents } from '../money.js';

type Db = Pool | PoolClient;

export function netSettlementPosition(input: {
  openingCents: bigint;
  cashInCents: bigint;
  cashOutCents: bigint;
  walletInflowCents: bigint;
  walletOutflowCents: bigint;
  commissionCents: bigint;
  feesCents: bigint;
  adjustmentsCents: bigint;
}): bigint {
  return (
    input.openingCents +
    input.cashInCents -
    input.cashOutCents +
    input.walletInflowCents -
    input.walletOutflowCents +
    input.commissionCents -
    input.feesCents +
    input.adjustmentsCents
  );
}

export async function upsertMerchantSettlementPositionPg(
  database: Db,
  input: {
    merchantUserId: string;
    poolId?: string;
    currency?: string;
    positionDate: string;
    cashInCents?: bigint;
    cashOutCents?: bigint;
    walletInflowCents?: bigint;
    walletOutflowCents?: bigint;
    commissionCents?: bigint;
    feesCents?: bigint;
    adjustmentsCents?: bigint;
  },
): Promise<{ id: string; netPositionCents: bigint }> {
  const existing = await database.query<{
    id: string;
    opening_cents: string;
    cash_in_cents: string;
    cash_out_cents: string;
    wallet_inflow_cents: string;
    wallet_outflow_cents: string;
    commission_cents: string;
    fees_cents: string;
    adjustments_cents: string;
  }>(
    `SELECT * FROM merchant_settlement_positions
      WHERE merchant_user_id = $1 AND pool_id = $2 AND currency = $3 AND position_date = $4
      FOR UPDATE`,
    [input.merchantUserId, input.poolId ?? 'ZA', input.currency ?? 'ZAR', input.positionDate],
  );
  const prev = existing.rows[0];
  const next = {
    openingCents: BigInt(prev?.opening_cents ?? '0'),
    cashInCents: BigInt(prev?.cash_in_cents ?? '0') + (input.cashInCents ?? 0n),
    cashOutCents: BigInt(prev?.cash_out_cents ?? '0') + (input.cashOutCents ?? 0n),
    walletInflowCents: BigInt(prev?.wallet_inflow_cents ?? '0') + (input.walletInflowCents ?? 0n),
    walletOutflowCents: BigInt(prev?.wallet_outflow_cents ?? '0') + (input.walletOutflowCents ?? 0n),
    commissionCents: BigInt(prev?.commission_cents ?? '0') + (input.commissionCents ?? 0n),
    feesCents: BigInt(prev?.fees_cents ?? '0') + (input.feesCents ?? 0n),
    adjustmentsCents: BigInt(prev?.adjustments_cents ?? '0') + (input.adjustmentsCents ?? 0n),
  };
  const net = netSettlementPosition(next);
  if (prev) {
    await database.query(
      `UPDATE merchant_settlement_positions
          SET cash_in_cents = $2, cash_out_cents = $3, wallet_inflow_cents = $4,
              wallet_outflow_cents = $5, commission_cents = $6, fees_cents = $7,
              adjustments_cents = $8, net_position_cents = $9
        WHERE id = $1`,
      [
        prev.id,
        next.cashInCents.toString(),
        next.cashOutCents.toString(),
        next.walletInflowCents.toString(),
        next.walletOutflowCents.toString(),
        next.commissionCents.toString(),
        next.feesCents.toString(),
        next.adjustmentsCents.toString(),
        net.toString(),
      ],
    );
    return { id: prev.id, netPositionCents: net };
  }
  const id = randomUUID();
  await database.query(
    `INSERT INTO merchant_settlement_positions
       (id, merchant_user_id, pool_id, currency, position_date, opening_cents,
        cash_in_cents, cash_out_cents, wallet_inflow_cents, wallet_outflow_cents,
        commission_cents, fees_cents, adjustments_cents, net_position_cents)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      id,
      input.merchantUserId,
      input.poolId ?? 'ZA',
      input.currency ?? 'ZAR',
      input.positionDate,
      next.openingCents.toString(),
      next.cashInCents.toString(),
      next.cashOutCents.toString(),
      next.walletInflowCents.toString(),
      next.walletOutflowCents.toString(),
      next.commissionCents.toString(),
      next.feesCents.toString(),
      next.adjustmentsCents.toString(),
      net.toString(),
    ],
  );
  return { id, netPositionCents: net };
}

/**
 * Builds a NET settlement batch. Does not submit a bank payout — external
 * movement stays BLOCKED until a contracted adapter exists.
 */
export async function createNetSettlementBatchPg(
  database: Db,
  input: { positionIds: string[]; provider: string; settlementDate: string },
): Promise<{ batchId: string; totalCents: bigint; itemCount: number; externalPayout: 'blocked' }> {
  if (input.positionIds.length === 0) {
    throw Object.assign(new Error('At least one settlement position is required'), { status: 400 });
  }
  const positions = await database.query<{
    id: string;
    net_position_cents: string;
    status: string;
    currency: string;
  }>(
    `SELECT id, net_position_cents, status, currency
       FROM merchant_settlement_positions WHERE id = ANY($1::uuid[]) FOR UPDATE`,
    [input.positionIds],
  );
  if (positions.rows.length !== input.positionIds.length) {
    throw Object.assign(new Error('Settlement position missing'), { status: 404 });
  }
  if (positions.rows.some((row) => row.status !== 'open')) {
    throw Object.assign(new Error('Position is not open for batching'), { status: 409 });
  }
  const total = positions.rows.reduce(
    (sum, row) => sum + parseIntegerCents(row.net_position_cents, { allowZero: true }),
    0n,
  );
  const batchId = randomUUID();
  await database.query(
    `INSERT INTO settlement_batches
       (id, batch_reference, currency, provider, settlement_date, state, item_count, total_cents)
     VALUES ($1,$2,$3,$4,$5,'created',$6,$7)`,
    [
      batchId,
      `NET-${batchId.slice(0, 8).toUpperCase()}`,
      positions.rows[0]?.currency ?? 'ZAR',
      input.provider,
      input.settlementDate,
      positions.rows.length,
      (total < 0n ? 0n : total).toString(),
    ],
  );
  for (const row of positions.rows) {
    await database.query(
      `INSERT INTO settlement_batch_items (id, batch_id, position_id, net_cents)
       VALUES ($1,$2,$3,$4)`,
      [randomUUID(), batchId, row.id, row.net_position_cents],
    );
    await database.query(
      `UPDATE merchant_settlement_positions SET status = 'batched' WHERE id = $1`,
      [row.id],
    );
  }
  return {
    batchId,
    totalCents: total,
    itemCount: positions.rows.length,
    externalPayout: 'blocked',
  };
}
