import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assertWalletKindPair } from './walletKindsPg.js';

describe('wallet kind pairs', () => {
  it('allows customer user → merchant sales', () => {
    assert.doesNotThrow(() =>
      assertWalletKindPair('user', 'merchant_sales', 'consumer_to_merchant'),
    );
  });

  it('rejects mixing merchant_float into a normal sale', () => {
    assert.throws(
      () => assertWalletKindPair('merchant_float', 'merchant_sales', 'consumer_to_merchant'),
      /not allowed/,
    );
  });

  it('requires Cash Send payout to land on merchant_float', () => {
    assert.doesNotThrow(() =>
      assertWalletKindPair('system_escrow', 'merchant_float', 'cash_send_payout'),
    );
    assert.throws(
      () => assertWalletKindPair('system_escrow', 'user', 'cash_send_payout'),
      /not allowed/,
    );
  });
});
