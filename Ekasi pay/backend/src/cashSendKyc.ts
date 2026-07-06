/** SA ID-style number: digits only (13-digit smart card barcode often encodes similarly). */
export function normalizeCashSendId(raw: string): string {
  return raw.replace(/\D/g, '');
}

export function validateSaIdDigits(digits: string): boolean {
  return digits.length === 13;
}

export function cashSendIdsMatch(expectedStored: string, scannedOrEntered: string): boolean {
  const a = normalizeCashSendId(expectedStored);
  const b = normalizeCashSendId(scannedOrEntered);
  if (!a || !b) return false;
  return a === b;
}
