/** SA ID-style number: digits only (13-digit smart card barcode often encodes similarly). */
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
