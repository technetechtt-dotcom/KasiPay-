import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  generateCashSendPayoutOtpCode,
  hashCashSendPayoutOtp,
} from './cashSendPayoutOtpPg.js';

describe('cash send payout OTP', () => {
  it('hashes codes with voucher and phone binding', () => {
    const a = hashCashSendPayoutOtp('voucher-1', '0820000000', '123456');
    const b = hashCashSendPayoutOtp('voucher-1', '0820000000', '123456');
    const other = hashCashSendPayoutOtp('voucher-1', '0820000000', '000000');
    assert.equal(a, b);
    assert.notEqual(a, other);
    assert.match(a, /^[a-f0-9]{64}$/);
  });

  it('generates a 6-digit code', () => {
    assert.match(generateCashSendPayoutOtpCode(), /^\d{6}$/);
  });
});
