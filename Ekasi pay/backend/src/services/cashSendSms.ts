import { CASH_SEND_COLLECT_HINT } from '../config.js';

import { sendSms } from './sms.js';

export type CashSendSmsPayload = {
  senderPhone: string;
  amount: string | number;
  beneficiaryName: string;
  referenceNumber: string;
  pin: string;
  expiresAt: string;
  shopName?: string;
  shopLocation?: string;
};

function formatExpiry(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-ZA', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return iso.slice(0, 10);
  }
}

/** Where the beneficiary can withdraw — shop that created the send, or configured hint. */
export function buildCashSendCollectHint(shop?: {
  name: string;
  location: string;
}): string {
  const name = shop?.name?.trim() ?? '';
  if (name) {
    const location = shop?.location?.trim() ?? '';
    const place = location ? `${name}, ${location}` : name;
    return `Withdraw at ${place} (Services > Collect cash) or any KasiPay partner shop.`;
  }
  return CASH_SEND_COLLECT_HINT;
}

export function formatCashSendReferenceSms(payload: CashSendSmsPayload): string {
  const beneficiary = payload.beneficiaryName.trim() || 'your beneficiary';
  const hint = buildCashSendCollectHint(
    payload.shopName ?
      { name: payload.shopName, location: payload.shopLocation ?? '' }
    : undefined,
  );
  return (
    `KasiPay Cash Send R${
      typeof payload.amount === 'number'
        ? payload.amount.toFixed(2)
        : payload.amount
    } for ${beneficiary}. ` +
    `Voucher: ${payload.referenceNumber}. ` +
    `${hint} Expires ${formatExpiry(payload.expiresAt)}.`
  );
}

export function formatCashSendPinSms(payload: Pick<CashSendSmsPayload, 'pin'>): string {
  return `KasiPay Cash Send PIN: ${payload.pin}. Share it only with the named beneficiary. The voucher number is sent separately.`;
}

/** Reference and PIN are deliberately delivered in separate messages. Never throws. */
export async function notifySenderCashSendVoucher(
  payload: CashSendSmsPayload,
): Promise<boolean> {
  try {
    await sendSms(payload.senderPhone, formatCashSendReferenceSms(payload));
    await sendSms(payload.senderPhone, formatCashSendPinSms(payload));
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'SMS delivery failed';
    console.error(`[cash-send-sms] delivery failed: ${msg}`);
    return false;
  }
}
