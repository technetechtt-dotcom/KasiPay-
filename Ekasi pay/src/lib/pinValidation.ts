/** Mirrors backend `validation.ts` weak-PIN rules for Cash Send voucher PINs. */
export function isWeakPin(pin: string): boolean {
  const digits = pin.replace(/\D/g, '');
  if (digits.length < 4) return true;
  if (/^(\d)\1+$/.test(digits)) return true;
  let asc = true;
  let desc = true;
  for (let i = 1; i < digits.length; i++) {
    const d = digits.charCodeAt(i) - digits.charCodeAt(i - 1);
    if (d !== 1) asc = false;
    if (d !== -1) desc = false;
  }
  return asc || desc;
}

export function isCashSendVoucherPinValid(pin: string): boolean {
  const digits = pin.replace(/\D/g, '');
  return digits.length === 4 && !isWeakPin(digits);
}

export function cashSendVoucherPinMessage(pin: string): string | null {
  const digits = pin.replace(/\D/g, '');
  if (digits.length !== 4) {
    return 'Please enter a 4-digit PIN.';
  }
  if (isWeakPin(digits)) {
    return 'PIN is too easy to guess — avoid 1234, 0000, or repeated digits.';
  }
  return null;
}
