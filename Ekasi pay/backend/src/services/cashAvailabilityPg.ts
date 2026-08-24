import type { Pool, PoolClient } from 'pg';

import { parseIntegerCents, type Cents } from '../money.js';

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

/** Inclusive ceiling in cents. `over_5000` has no ceiling. Missing/unavailable pays nothing. */
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

/**
 * Cash-out is gated on self-reported physical cash, not an electronic float floor.
 * A missing row is unavailable (fail closed).
 */
export async function assertPhysicalCashForPayoutPg(
  database: Db,
  merchantId: string,
  amountCents: Cents,
): Promise<{ availabilityBand: CashAvailabilityBand }> {
  const amount = parseIntegerCents(amountCents);
  const row = await database.query<{ availability_band: string }>(
    `SELECT availability_band FROM merchant_cash_availability WHERE merchant_id = $1`,
    [merchantId],
  );
  const band = (row.rows[0]?.availability_band ?? 'unavailable') as CashAvailabilityBand;
  if (!physicalCashCoversPayout(band, amount)) {
    throw Object.assign(
      new Error(
        'Shop physical cash availability is insufficient for this cash-out. Update the cash-on-hand band before paying.',
      ),
      { status: 400, code: 'PHYSICAL_CASH_UNAVAILABLE' },
    );
  }
  return { availabilityBand: band };
}
