import type { PaymentProduct, PaymentRail, PaymentRailId } from './types.js';

const rails = new Map<PaymentRailId, PaymentRail>();

export const PaymentRailRegistry = {
  register(rail: PaymentRail): void {
    rails.set(rail.id, rail);
  },
  get(id: PaymentRailId): PaymentRail | undefined {
    return rails.get(id);
  },
  enabled(): PaymentRail[] {
    return [...rails.values()].filter((rail) => !rail.optional || rail.id === 'internal_wallet');
  },
  forProduct(product: PaymentProduct): PaymentRail[] {
    return this.enabled().filter((rail) => rail.supports(product));
  },
  resetForTests(): void {
    rails.clear();
  },
};
