import type { PaymentProduct, PaymentRail } from '../types.js';

const PRODUCTS: PaymentProduct[] = [
  'consumer_to_merchant',
  'merchant_to_merchant',
  'consumer_to_consumer',
  'merchant_internal_transfer',
  'refund',
];

export const internalWalletRail: PaymentRail = {
  id: 'internal_wallet',
  displayName: 'KasiPay internal wallet',
  optional: false,
  capabilities: ['authorize', 'capture', 'status', 'refund', 'reverse', 'reconcile'],
  supports: (product) => PRODUCTS.includes(product),
};
