import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { parseIntegerCents, parseZarToCents, type Cents } from '../money.js';

type Db = Pool | PoolClient;

export const CASH_AVAILABILITY_BANDS = [
  'unavailable',
  'under_500',
  '500_to_1000',
  '1000_to_2000',
  '2000_to_5000',
  'over_5000',
] as const;

export type CashAvailabilityBand = (typeof CASH_AVAILABILITY_BANDS)[number];

export type CashLiquidity = {
  availableCents: Cents;
  reservedCents: Cents;
  freeCents: Cents;
};

/** Inclusive ceiling in cents used only as a conservative seed. `over_5000` has none. */
export function cashBandMaxPayoutCents(band: string | null | undefined): Cents | null {
  switch (band) {
    case 'under_500':
      return 49_999n as Cents;
    case '500_to_1000':
      return 99_999n as Cents;
    case '1000_to_2000':
      return 199_999n as Cents;
    case '2000_to_5000':
      return 499_999n as Cents;
    case 'over_5000':
      return null;
    default:
      return 0n as Cents;
  }
}

export function physicalCashCoversPayout(
  band: string | null | undefined,
  amountCents: Cents,
): boolean {
  const amount = parseIntegerCents(amountCents);
  const max = cashBandMaxPayoutCents(band);
  if (max === 0n as Cents) return false;
  if (max === null) return amount > 0n;
  return amount > 0n && amount <= max;
}

export function bandToAvailableCents(
  band: CashAvailabilityBand,
  explicitCents?: Cents,
): Cents {
  if (explicitCents !== undefined) return parseIntegerCents(explicitCents, { allowZero: true });
  if (band === 'unavailable') return 0n as Cents;
  if (band === 'over_5000') {
    throw Object.assign(
      new Error('over_5000 requires an explicit availableCents cash-on-hand figure'),
      { status: 400, code: 'CASH_CENTS_REQUIRED' },
    );
  }
  const max = cashBandMaxPayoutCents(band);
  return (max ?? 0n) as Cents;
}

export async function getCashLiquidityPg(
  database: Db,
  merchantId: string,
): Promise<CashLiquidity> {
  const row = await database.query<{ available_cents: string; reserved_cents: string }>(
    `SELECT available_cents, reserved_cents FROM merchant_cash_liquidity WHERE merchant_id = $1`,
    [merchantId],
  );
  const available = parseIntegerCents(row.rows[0]?.available_cents ?? '0', { allowZero: true });
  const reserved = parseIntegerCents(row.rows[0]?.reserved_cents ?? '0', { allowZero: true });
  return {
    availableCents: available,
    reservedCents: reserved,
    freeCents: (available - reserved) as Cents,
  };
}

export async function declareCashLiquidityPg(
  database: Db,
  merchantId: string,
  availableCents: Cents,
  band?: CashAvailabilityBand,
): Promise<CashLiquidity> {
  const available = parseIntegerCents(availableCents, { allowZero: true });
  const updated = await database.query<{ available_cents: string; reserved_cents: string }>(
    `INSERT INTO merchant_cash_liquidity (merchant_id, available_cents, reserved_cents, updated_at)
     VALUES ($1, $2, 0, clock_timestamp())
     ON CONFLICT (merchant_id)
     DO UPDATE SET available_cents = EXCLUDED.available_cents, updated_at = clock_timestamp()
     WHERE merchant_cash_liquidity.reserved_cents <= EXCLUDED.available_cents
     RETURNING available_cents, reserved_cents`,
    [merchantId, available.toString()],
  );
  if (!updated.rows[0]) {
    throw Object.assign(
      new Error('Cannot reduce cash-on-hand below currently reserved payouts'),
      { status: 409, code: 'CASH_RESERVED_EXCEEDS_AVAILABLE' },
    );
  }
  if (band) {
    await database.query(
      `INSERT INTO merchant_cash_availability (merchant_id, availability_band, updated_at)
       VALUES ($1,$2,clock_timestamp())
       ON CONFLICT (merchant_id)
       DO UPDATE SET availability_band = EXCLUDED.availability_band, updated_at = clock_timestamp()`,
      [merchantId, band],
    );
  }
  const reserved = parseIntegerCents(updated.rows[0].reserved_cents, { allowZero: true });
  return {
    availableCents: parseIntegerCents(updated.rows[0].available_cents, { allowZero: true }),
    reservedCents: reserved,
    freeCents: (available - reserved) as Cents,
  };
}

/**
 * Reserve physical cash inside an open transaction. Caller must hold a voucher
 * row lock first, then call this so concurrent collects serialize on the agent.
 */
export async function reserveCashLiquidityPg(
  client: PoolClient,
  merchantId: string,
  amountCents: Cents,
  voucherId: string,
): Promise<void> {
  const amount = parseIntegerCents(amountCents);
  const liquidity = await client.query<{ available_cents: string; reserved_cents: string }>(
    `SELECT available_cents, reserved_cents
       FROM merchant_cash_liquidity
      WHERE merchant_id = $1
      FOR UPDATE`,
    [merchantId],
  );
  const row = liquidity.rows[0];
  if (!row) {
    throw Object.assign(
      new Error(
        'Shop cash liquidity is not declared. Update cash-on-hand before paying.',
      ),
      { status: 400, code: 'PHYSICAL_CASH_UNAVAILABLE' },
    );
  }
  const available = parseIntegerCents(row.available_cents, { allowZero: true });
  const reserved = parseIntegerCents(row.reserved_cents, { allowZero: true });
  if (available - reserved < amount) {
    throw Object.assign(
      new Error('Shop physical cash liquidity is insufficient for this cash-out.'),
      { status: 400, code: 'PHYSICAL_CASH_UNAVAILABLE' },
    );
  }
  await client.query(
    `UPDATE merchant_cash_liquidity
        SET reserved_cents = reserved_cents + $2, updated_at = clock_timestamp()
      WHERE merchant_id = $1 AND available_cents - reserved_cents >= $2`,
    [merchantId, amount.toString()],
  );
  await client.query(
    `INSERT INTO merchant_cash_reservations
       (id, merchant_id, voucher_id, amount_cents, state)
     VALUES ($1,$2,$3,$4,'reserved')`,
    [randomUUID(), merchantId, voucherId, amount.toString()],
  );
}

export async function consumeCashReservationPg(
  client: PoolClient,
  merchantId: string,
  voucherId: string,
  amountCents: Cents,
): Promise<void> {
  const amount = parseIntegerCents(amountCents);
  const reserved = await client.query(
    `UPDATE merchant_cash_reservations
        SET state = 'consumed', updated_at = clock_timestamp()
      WHERE voucher_id = $1 AND merchant_id = $2 AND state = 'reserved'`,
    [voucherId, merchantId],
  );
  if (!reserved.rowCount) {
    throw Object.assign(new Error('Cash reservation missing'), {
      status: 409,
      code: 'CASH_RESERVATION_MISSING',
    });
  }
  const consumed = await client.query(
    `UPDATE merchant_cash_liquidity
        SET available_cents = available_cents - $2,
            reserved_cents = reserved_cents - $2,
            updated_at = clock_timestamp()
      WHERE merchant_id = $1
        AND available_cents >= $2
        AND reserved_cents >= $2`,
    [merchantId, amount.toString()],
  );
  if (!consumed.rowCount) {
    throw Object.assign(new Error('Cash liquidity consume failed'), {
      status: 409,
      code: 'CASH_LIQUIDITY_CONSUME_FAILED',
    });
  }
}

/** @deprecated Bands are a UI hint. Cash-out uses merchant_cash_liquidity. */
export async function assertPhysicalCashForPayoutPg(
  database: Db,
  merchantId: string,
  amountCents: Cents,
): Promise<{ availabilityBand: CashAvailabilityBand; freeCents: Cents }> {
  const liquidity = await getCashLiquidityPg(database, merchantId);
  const amount = parseIntegerCents(amountCents);
  if (liquidity.freeCents < amount) {
    throw Object.assign(
      new Error(
        'Shop physical cash availability is insufficient for this cash-out. Update cash-on-hand before paying.',
      ),
      { status: 400, code: 'PHYSICAL_CASH_UNAVAILABLE' },
    );
  }
  const band = await database.query<{ availability_band: string }>(
    `SELECT availability_band FROM merchant_cash_availability WHERE merchant_id = $1`,
    [merchantId],
  );
  return {
    availabilityBand: (band.rows[0]?.availability_band ?? 'unavailable') as CashAvailabilityBand,
    freeCents: liquidity.freeCents,
  };
}

export function parseAvailableCentsInput(raw: string | number): Cents {
  return parseZarToCents(raw, { allowZero: true });
}
