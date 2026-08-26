import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canTransitionBankLifecycle } from './bankTransactionLifecyclePg.js';

describe('bank transaction finality', () => {
  it('allows received → pending/posted/settled/rejected/reversed', () => {
    assert.equal(canTransitionBankLifecycle('received', 'settled'), true);
    assert.equal(canTransitionBankLifecycle('received', 'pending'), true);
    assert.equal(canTransitionBankLifecycle('pending', 'settled'), true);
  });

  it('never treats pending as a final credit state', () => {
    assert.equal(canTransitionBankLifecycle('pending', 'received'), false);
    assert.equal(canTransitionBankLifecycle('settled', 'pending'), false);
    assert.equal(canTransitionBankLifecycle('reversed', 'settled'), false);
    assert.equal(canTransitionBankLifecycle('rejected', 'settled'), false);
  });
});
