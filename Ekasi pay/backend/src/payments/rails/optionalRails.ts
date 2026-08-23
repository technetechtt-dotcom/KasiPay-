import type { PaymentRail, PaymentRailId } from '../types.js';

function stub(id: PaymentRailId, displayName: string): PaymentRail {
  return {
    id,
    displayName,
    optional: true,
    capabilities: ['status'],
    supports: () => false,
  };
}

/** Future adapters only — never registered as enabled launch rails. */
export const optionalPaymentRails: PaymentRail[] = [
  stub('payshap', 'PayShap (optional future rail)'),
  stub('card', 'Card via PCI PSP (optional)'),
  stub('instant_eft', 'Instant EFT (optional)'),
  stub('bank_eft', 'Bank EFT (optional)'),
  stub('qr', 'QR checkout (optional)'),
];
