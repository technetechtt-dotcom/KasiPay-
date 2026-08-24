import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { activationIsComplete, kycIsAcceptable } from './payoutAgentsPg.js';

describe('payout-agent KYC and activation', () => {
  it('fail closed unless KYC is verified or approved', () => {
    assert.equal(kycIsAcceptable('verified'), true);
    assert.equal(kycIsAcceptable('approved'), true);
    assert.equal(kycIsAcceptable('pending'), false);
    assert.equal(kycIsAcceptable('rejected'), false);
    assert.equal(kycIsAcceptable(null), false);
  });

  it('fail closed unless merchant activation is complete', () => {
    assert.equal(activationIsComplete('paid'), true);
    assert.equal(activationIsComplete('waived'), true);
    assert.equal(activationIsComplete('complete'), true);
    assert.equal(activationIsComplete('pending'), false);
    assert.equal(activationIsComplete(null), false);
  });
});
