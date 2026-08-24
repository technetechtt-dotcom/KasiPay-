import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { usesPaymentIntentRow } from './intentScope.js';

describe('payment_intents scope', () => {
  it('is only for orchestrated or external rails', () => {
    assert.equal(usesPaymentIntentRow('internal_wallet'), false);
    assert.equal(usesPaymentIntentRow('cash'), false);
    assert.equal(usesPaymentIntentRow('cash_send'), false);
    assert.equal(usesPaymentIntentRow('bank_deposit'), true);
    assert.equal(usesPaymentIntentRow('bank_payout'), true);
    assert.equal(usesPaymentIntentRow('payshap'), true);
  });
});
