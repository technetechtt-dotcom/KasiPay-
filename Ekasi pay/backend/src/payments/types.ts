import type { Cents } from '../money.js';

export type PaymentProduct =
  | 'consumer_to_merchant'
  | 'merchant_to_merchant'
  | 'consumer_to_consumer'
  | 'merchant_internal_transfer'
  | 'cash_send'
  | 'pos_cash'
  | 'float_topup'
  | 'float_withdrawal'
  | 'refund';

export type PaymentRailId =
  | 'internal_wallet'
  | 'cash'
  | 'bank_deposit'
  | 'bank_payout'
  | 'cash_send'
  | 'bank_eft'
  | 'payshap'
  | 'card'
  | 'instant_eft'
  | 'qr';

export type PaymentState =
  | 'created'
  | 'pending'
  | 'authorized'
  | 'submitted'
  | 'processing'
  | 'fulfilled'
  | 'failed'
  | 'unknown'
  | 'reversed'
  | 'refunded'
  | 'cancelled';

export type RailCapability =
  | 'authorize'
  | 'capture'
  | 'status'
  | 'refund'
  | 'reverse'
  | 'reconcile';

export type PaymentIntent = {
  id: string;
  product: PaymentProduct;
  rail: PaymentRailId;
  state: PaymentState;
  amountCents: Cents;
  currency: string;
  poolId: string;
  actorUserId: string;
  counterpartyUserId?: string;
  sourceWalletId?: string;
  destinationWalletId?: string;
  financialReference: string;
  idempotencyKey?: string;
  originalPaymentId?: string;
  metadata?: Record<string, unknown>;
};

export type PaymentResult = {
  intentId: string;
  state: PaymentState;
  rail: PaymentRailId;
  transactionId?: string;
  reference: string;
  message?: string;
};

export type PaymentRail = {
  id: PaymentRailId;
  displayName: string;
  optional: boolean;
  capabilities: readonly RailCapability[];
  supports(product: PaymentProduct): boolean;
  authorize?(intent: PaymentIntent): Promise<PaymentResult>;
  capture?(intent: PaymentIntent): Promise<PaymentResult>;
  status?(intent: PaymentIntent): Promise<PaymentResult>;
  refund?(intent: PaymentIntent): Promise<PaymentResult>;
  reverse?(intent: PaymentIntent): Promise<PaymentResult>;
  reconcile?(intent: PaymentIntent): Promise<PaymentResult>;
};
