import type { PaymentRail } from '../types.js';

export const cashRail: PaymentRail = {
  id: 'cash',
  displayName: 'In-shop cash',
  optional: false,
  capabilities: ['capture', 'status', 'reverse'],
  supports: (product) => product === 'pos_cash' || product === 'refund',
};
