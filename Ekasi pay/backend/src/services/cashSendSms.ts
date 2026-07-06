import { CASH_SEND_COLLECT_HINT } from '../config.js';

import { sendSms } from './sms.js';

export type CashSendSmsPayload = {
  senderPhone: string;
  amount: number;
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

export function formatCashSendVoucherSms(payload: CashSendSmsPayload): string {
  const beneficiary = payload.beneficiaryName.trim() || 'your beneficiary';
  const hint = buildCashSendCollectHint(
    payload.shopName ?
      { name: payload.shopName, location: payload.shopLocation ?? '' }
    : undefined,
  );
  return (
    `KasiPay Cash Send R${payload.amount.toFixed(2)} for ${beneficiary}. ` +
    `Voucher: ${payload.referenceNumber} PIN: ${payload.pin}. ` +
    `${hint} Expires ${formatExpiry(payload.expiresAt)}.`
  );
}

/** SMS the sender their voucher ref, PIN, and where to withdraw. Never throws. */
export async function notifySenderCashSendVoucher(
  payload: CashSendSmsPayload,
): Promise<boolean> {
  try {
    await sendSms(payload.senderPhone, formatCashSendVoucherSms(payload));
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'SMS delivery failed';
    console.error(`[cash-send-sms] failed for ${payload.senderPhone}: ${msg}`);
    return false;
  }
}
