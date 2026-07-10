import { describe, expect, it } from 'vitest';
import {
  isCashSendVoucherReference,
  parseCashSendVoucherReference,
} from './cashSendReference';

describe('cashSendReference', () => {
  it('accepts digit and hex CS voucher numbers', () => {
    expect(parseCashSendVoucherReference(' cs1783348762065946 ')).toBe(
      'CS1783348762065946',
    );
    expect(parseCashSendVoucherReference('cs1a2b3c4d5e6f70')).toBe(
      'CS1A2B3C4D5E6F70',
    );
    expect(isCashSendVoucherReference('CSABCDEF01234567')).toBe(true);
  });

  it('rejects cellphones and non-CS values', () => {
    expect(parseCashSendVoucherReference('0697040585')).toBeNull();
    expect(parseCashSendVoucherReference('ABC123')).toBeNull();
  });
});
