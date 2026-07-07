/** SA ID-style number: digits only (13-digit smart card barcode often encodes similarly). */
import { randomUUID } from 'node:crypto';

export function normalizeCashSendId(raw: string): string {
  return raw.replace(/\D/g, '');
}

/**
 * South African ID checksum (Luhn variant on the first 12 digits).
 * @see https://en.wikipedia.org/wiki/South_African_identity_card
 */
export function isValidSaIdChecksum(digits: string): boolean {
  if (!/^\d{13}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    let d = Number(digits[i]);
    if (i % 2 !== 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === Number(digits[12]);
}

export function validateSaIdDigits(digits: string): boolean {
  return digits.length === 13 && isValidSaIdChecksum(digits);
}

export function cashSendIdsMatch(expectedStored: string, scannedOrEntered: string): boolean {
  const a = normalizeCashSendId(expectedStored);
  const b = normalizeCashSendId(scannedOrEntered);
  if (!a || !b) return false;
  return a === b;
}

/** Strip spaces and normalise case for CS… voucher numbers. */
export function normalizeCashSendReference(raw: string): string {
  return raw.replace(/\s+/g, '').trim().toUpperCase();
}

export function isSaCellphoneInput(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  return /^0\d{9}$/.test(digits);
}

/** Public voucher number issued at send — the only key for collect. */
export function isCashSendVoucherReference(raw: string): boolean {
  const ref = normalizeCashSendReference(raw);
  return ref.startsWith('CS') && ref.length >= 10 && /^CS\d+$/.test(ref);
}

/**
 * Normalise and validate a collect lookup key. Rejects cellphones, internal IDs,
 * and any value that is not a CS… voucher number.
 */
export function parseCashSendVoucherReference(raw: string): string | null {
  const trimmed = raw.replace(/\s+/g, '').trim();
  if (!trimmed || isSaCellphoneInput(trimmed)) return null;
  const ref = normalizeCashSendReference(trimmed);
  return isCashSendVoucherReference(ref) ? ref : null;
}

/** Unique public voucher number (CS + 14 hex chars). */
export function generateCashSendReference(): string {
  return `CS${randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase()}`;
}
