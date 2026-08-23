import { PaymentRailRegistry } from './paymentRailRegistry.js';
import type { PaymentProduct, PaymentRail, PaymentRailId } from './types.js';

export type RoutePaymentInput = {
  product: PaymentProduct;
  requestedRail?: PaymentRailId;
  amountCents: bigint;
};

/**
 * Chooses a rail without silently substituting one that would change
 * customer fees or settlement semantics.
 */
export function routePayment(input: RoutePaymentInput): PaymentRail {
  if (input.requestedRail) {
    const requested = PaymentRailRegistry.get(input.requestedRail);
    if (!requested || requested.optional) {
      throw Object.assign(new Error(`Payment rail ${input.requestedRail} is not available`), {
        status: 400,
        code: 'RAIL_UNAVAILABLE',
      });
    }
    if (!requested.supports(input.product)) {
      throw Object.assign(
        new Error(`Rail ${input.requestedRail} cannot process ${input.product}`),
        { status: 400, code: 'RAIL_PRODUCT_MISMATCH' },
      );
    }
    return requested;
  }

  if (input.product === 'pos_cash') return must('cash');
  if (input.product === 'cash_send') return must('cash_send');
  if (input.product === 'float_topup') return must('bank_deposit');
  if (input.product === 'float_withdrawal') return must('bank_payout');
  return must('internal_wallet');
}

function must(id: PaymentRailId): PaymentRail {
  const rail = PaymentRailRegistry.get(id);
  if (!rail) {
    throw Object.assign(new Error(`Required rail ${id} is not registered`), { status: 503 });
  }
  return rail;
}
