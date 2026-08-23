import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PaymentRailRegistry } from './paymentRailRegistry.js';
import { routePayment } from './paymentRouter.js';
import { registerLaunchPaymentRails } from './registerLaunchRails.js';

registerLaunchPaymentRails();

describe('payment rails', () => {
  it('does not register PayShap as an enabled launch rail', () => {
    assert.equal(PaymentRailRegistry.get('payshap'), undefined);
    assert.ok(PaymentRailRegistry.get('internal_wallet'));
  });

  it('routes wallet products to the internal wallet rail', () => {
    assert.equal(routePayment({ product: 'consumer_to_merchant', amountCents: 100n }).id, 'internal_wallet');
    assert.equal(routePayment({ product: 'consumer_to_consumer', amountCents: 100n }).id, 'internal_wallet');
    assert.equal(routePayment({ product: 'pos_cash', amountCents: 100n }).id, 'cash');
    assert.equal(routePayment({ product: 'cash_send', amountCents: 100n }).id, 'cash_send');
    assert.equal(routePayment({ product: 'float_topup', amountCents: 100n }).id, 'bank_deposit');
  });

  it('refuses a silent PayShap substitution', () => {
    assert.throws(
      () =>
        routePayment({
          product: 'consumer_to_merchant',
          requestedRail: 'payshap',
          amountCents: 100n,
        }),
      /not available/,
    );
  });
});
