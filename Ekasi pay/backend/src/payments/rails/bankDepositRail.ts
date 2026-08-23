import type { PaymentRail } from '../types.js';

export const bankDepositRail: PaymentRail = {
  id: 'bank_deposit',
  displayName: 'Bank deposit / EFT top-up',
  optional: false,
  capabilities: ['status', 'reconcile'],
  supports: (product) => product === 'float_topup',
};
