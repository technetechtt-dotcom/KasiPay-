import { parseIntegerCents, type Cents } from '../money.js';
import type { FeeComponent } from './feeEnginePg.js';

/** v3 create posts R1 sending + R6 platform. R2 stays in escrow until collect. */
export function createTimeFeeComponents(
  components: Record<FeeComponent, Cents>,
): Record<FeeComponent, Cents> {
  return {
    ...components,
    agent: 0n as Cents,
  };
}

export function collectTimeAgentFee(components: Record<FeeComponent, Cents>): Cents {
  return (components.agent ?? 0n) as Cents;
}

export function feeComponentsPositive(
  components: Record<FeeComponent, Cents>,
): boolean {
  return (Object.values(components) as Cents[]).some((amount) => amount > 0n);
}

/**
 * Cancel/expiry reverse create-time components only (R6 platform + R1 send).
 * Never reverse the full R9 onto the platform line; R2 was never accrued.
 */
export function createFeeReversalAmounts(input: {
  platformFeeCents: string | number | bigint;
  merchantCommissionCents: string | number | bigint;
}): { platform: Cents; merchant: Cents } {
  return {
    platform: parseIntegerCents(input.platformFeeCents, { allowZero: true }),
    merchant: parseIntegerCents(input.merchantCommissionCents, { allowZero: true }),
  };
}
