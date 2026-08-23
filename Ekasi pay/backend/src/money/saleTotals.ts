import { parseIntegerCents, type Cents } from '../money.js';

export type SaleMoneyTotals = {
  grossTotalCents: Cents;
  discountCents: Cents;
  netTotalCents: Cents;
};

export function computeSaleTotals(
  grossTotalCents: Cents | bigint | string | number,
  discountCents: Cents | bigint | string | number = 0,
): SaleMoneyTotals {
  const gross = parseIntegerCents(grossTotalCents, { allowZero: true });
  const discount = parseIntegerCents(discountCents, { allowZero: true });
  if (discount < 0n) {
    throw Object.assign(new Error('Discount cannot be negative'), { status: 400 });
  }
  if (discount > gross) {
    throw Object.assign(new Error('Discount cannot exceed the sale total'), {
      status: 400,
      code: 'DISCOUNT_EXCEEDS_GROSS',
    });
  }
  return {
    grossTotalCents: gross,
    discountCents: discount,
    netTotalCents: (gross - discount) as Cents,
  };
}
