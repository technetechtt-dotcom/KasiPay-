import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCashSendCollectHint,
  formatCashSendPinSms,
  formatCashSendReferenceSms,
} from './services/cashSendSms.js';

describe('cashSend voucher SMS', () => {
  it('keeps voucher reference and PIN in separate messages', () => {
    const payload = {
      senderPhone: '0821234567',
      amount: 500,
      beneficiaryName: 'Joseph Money',
      referenceNumber: 'CS1783348762065946',
      pin: '4829',
      expiresAt: '2026-07-20T14:39:22.065Z',
      shopName: 'Demo Spaza',
      shopLocation: 'Soweto',
    };
    const reference = formatCashSendReferenceSms(payload);
    const pin = formatCashSendPinSms(payload);
    assert.match(reference, /CS1783348762065946/);
    assert.doesNotMatch(reference, /4829/);
    assert.match(pin, /PIN: 4829/);
    assert.doesNotMatch(pin, /CS1783348762065946/);
    assert.match(reference, /Joseph Money/);
    assert.match(reference, /Demo Spaza, Soweto/);
  });

  it('uses default collect hint when shop is unknown', () => {
    const hint = buildCashSendCollectHint();
    assert.match(hint, /KasiPay/);
  });
});
