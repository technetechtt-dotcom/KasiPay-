import type { PaymentRailId } from './types.js';

/**
 * `payment_intents` is not a universal ledger.
 *
 * Authoritative money movement is always `journal_transactions` + `journal_entries`.
 * Intents exist only when a payment is routed through the orchestrator for an
 * external or bank-adapter rail (or a future PSP). In-process rails post
 * journals directly and must not insert a silent intent row.
 */
export const PAYMENT_INTENT_SCOPE = 'orchestrated_external_rails_only' as const;

const ORCHESTRATED_RAILS: ReadonlySet<PaymentRailId> = new Set([
  'bank_deposit',
  'bank_payout',
  'bank_eft',
  'payshap',
  'card',
  'instant_eft',
  'qr',
]);

export function usesPaymentIntentRow(rail: PaymentRailId): boolean {
  return ORCHESTRATED_RAILS.has(rail);
}
