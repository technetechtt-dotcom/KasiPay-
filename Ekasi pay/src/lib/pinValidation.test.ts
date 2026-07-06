import { describe, expect, it } from 'vitest';

import {
  cashSendVoucherPinMessage,
  isCashSendVoucherPinValid,
  isWeakPin,
} from './pinValidation';

describe('pinValidation', () => {
  it('rejects weak 4-digit PINs', () => {
    expect(isWeakPin('1234')).toBe(true);
    expect(isWeakPin('0000')).toBe(true);
    expect(isCashSendVoucherPinValid('1234')).toBe(false);
  });

  it('accepts non-trivial 4-digit voucher PINs', () => {
    expect(isCashSendVoucherPinValid('1927')).toBe(true);
    expect(cashSendVoucherPinMessage('1927')).toBeNull();
  });

  it('returns helpful messages for invalid PINs', () => {
    expect(cashSendVoucherPinMessage('12')).toMatch(/4-digit/);
    expect(cashSendVoucherPinMessage('1234')).toMatch(/too easy/);
  });
});
