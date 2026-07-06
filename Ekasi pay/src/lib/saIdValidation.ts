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

/** Score how likely a 13-digit run is the actual SA ID (higher = better). */
export function scoreSaIdCandidate(digits: string): number {
  if (!/^\d{13}$/.test(digits) || !isValidSaIdChecksum(digits)) return -1;
  let score = 0;
  const mm = Number(digits.slice(2, 4));
  const dd = Number(digits.slice(4, 6));
  const citizenship = Number(digits[10]);
  const status = Number(digits[11]);
  if (mm >= 1 && mm <= 12) score += 2;
  if (dd >= 1 && dd <= 31) score += 2;
  if (citizenship === 0 || citizenship === 1) score += 3;
  if (status === 8 || status === 9) score += 1;
  return score;
}

export function saIdValidationMessage(digits: string): string | null {
  const normalized = digits.replace(/\D/g, '');
  if (normalized.length !== 13) {
    return 'SA ID must be exactly 13 digits.';
  }
  if (!isValidSaIdChecksum(normalized)) {
    const tail = normalized.slice(-4);
    return (
      `This SA ID number failed the checksum — recheck every digit from the document, ` +
      `especially the last digit (ends …${tail}).`
    );
  }
  return null;
}
