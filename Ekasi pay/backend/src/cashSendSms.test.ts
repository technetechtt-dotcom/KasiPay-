import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCashSendCollectHint,
  formatCashSendVoucherSms,
} from './services/cashSendSms.js';

describe('cashSend voucher SMS', () => {
  it('includes voucher number, PIN, and shop withdraw hint', () => {
    const body = formatCashSendVoucherSms({
      senderPhone: '0821234567',
      amount: 500,
      beneficiaryName: 'Joseph Money',
      referenceNumber: 'CS1783348762065946',
      pin: '4829',
      expiresAt: '2026-07-20T14:39:22.065Z',
      shopName: 'Demo Spaza',
      shopLocation: 'Soweto',
    });
    assert.match(body, /CS1783348762065946/);
    assert.match(body, /PIN: 4829/);
    assert.match(body, /Joseph Money/);
    assert.match(body, /Demo Spaza, Soweto/);
    assert.match(body, /Collect cash/);
  });

  it('uses default collect hint when shop is unknown', () => {
    const hint = buildCashSendCollectHint();
    assert.match(hint, /KasiPay/);
  });
});
