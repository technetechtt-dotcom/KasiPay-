/** Strip spaces and normalise CS… voucher numbers. */
export function normalizeCashSendReference(raw: string): string {
  return raw.replace(/\s+/g, '').trim().toUpperCase();
}

export function isSaCellphoneInput(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  return /^0\d{9}$/.test(digits);
}

/** Collect accepts only CS-prefixed voucher numbers. */
export function isCashSendVoucherReference(raw: string): boolean {
  const ref = normalizeCashSendReference(raw);
  return ref.startsWith('CS') && ref.length >= 10 && /^CS\d+$/.test(ref);
}

export function parseCashSendVoucherReference(raw: string): string | null {
  const trimmed = raw.replace(/\s+/g, '').trim();
  if (!trimmed || isSaCellphoneInput(trimmed)) return null;
  const ref = normalizeCashSendReference(trimmed);
  return isCashSendVoucherReference(ref) ? ref : null;
}
