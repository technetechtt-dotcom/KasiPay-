/** Strip spaces and normalise CS… voucher numbers. */
export function normalizeCashSendReference(raw: string): string {
  return raw.replace(/\s+/g, '').trim().toUpperCase();
}

export function isSaCellphoneInput(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  return /^0\d{9}$/.test(digits);
}

/**
 * Collect accepts CS-prefixed voucher numbers.
 * Issued refs are `CS` + 14 hex chars (see backend `generateCashSendReference`).
 */
export function isCashSendVoucherReference(raw: string): boolean {
  const ref = normalizeCashSendReference(raw);
  return ref.startsWith('CS') && ref.length >= 10 && /^CS[0-9A-F]+$/.test(ref);
}

export function parseCashSendVoucherReference(raw: string): string | null {
  const trimmed = raw.replace(/\s+/g, '').trim();
  if (!trimmed || isSaCellphoneInput(trimmed)) return null;
  const ref = normalizeCashSendReference(trimmed);
  return isCashSendVoucherReference(ref) ? ref : null;
}
