import type { PaymentRail } from '../types.js';

export const bankPayoutRail: PaymentRail = {
  id: 'bank_payout',
  displayName: 'Bank payout / settlement',
  optional: false,
  capabilities: ['authorize', 'status', 'reconcile'],
  supports: (product) => product === 'float_withdrawal',
};
