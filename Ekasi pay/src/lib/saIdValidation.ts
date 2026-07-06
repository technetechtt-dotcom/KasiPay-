/** Mirrors backend `cashSendKyc.ts` SA ID checksum rules. */
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

export function isValidSaIdDigits(digits: string): boolean {
  const normalized = digits.replace(/\D/g, '');
  return normalized.length === 13 && isValidSaIdChecksum(normalized);
}

export function saIdValidationMessage(digits: string): string | null {
  const normalized = digits.replace(/\D/g, '');
  if (normalized.length !== 13) {
    return 'SA ID must be exactly 13 digits.';
  }
  if (!isValidSaIdChecksum(normalized)) {
    return 'This SA ID number failed the checksum — recheck the digits from the document.';
  }
  return null;
}
