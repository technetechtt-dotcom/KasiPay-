import type { PaymentRail } from '../types.js';

export const cashSendRail: PaymentRail = {
  id: 'cash_send',
  displayName: 'KasiPay Cash Send ledger',
  optional: false,
  capabilities: ['authorize', 'capture', 'status', 'refund', 'reverse', 'reconcile'],
  supports: (product) => product === 'cash_send',
};
