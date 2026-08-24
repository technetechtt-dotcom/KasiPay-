import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  cashBandMaxPayoutCents,
  physicalCashCoversPayout,
} from './cashAvailabilityPg.js';

describe('physical cash-out eligibility', () => {
  it('fails closed when the band is missing or unavailable', () => {
    assert.equal(physicalCashCoversPayout(null, 100n), false);
    assert.equal(physicalCashCoversPayout('unavailable', 100n), false);
    assert.equal(cashBandMaxPayoutCents('unavailable'), 0n);
  });

  it('uses the physical cash band, not an electronic float floor', () => {
    assert.equal(physicalCashCoversPayout('under_500', 49_999n), true);
    assert.equal(physicalCashCoversPayout('under_500', 50_000n), false);
    assert.equal(physicalCashCoversPayout('over_5000', 800_000n), true);
  });
});
