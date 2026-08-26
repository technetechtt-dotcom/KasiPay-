import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  bandToAvailableCents,
  cashBandMaxPayoutCents,
  cashLiquidityIsStale,
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

  it('seeds liquidity from a band ceiling and requires cents for over_5000', () => {
    assert.equal(bandToAvailableCents('under_500'), 49_999n);
    assert.equal(bandToAvailableCents('over_5000', 800_000n), 800_000n);
    assert.throws(() => bandToAvailableCents('over_5000'), /explicit availableCents/);
  });

  it('treats cash declarations older than 6 hours as stale', () => {
    assert.equal(cashLiquidityIsStale(null), true);
    assert.equal(cashLiquidityIsStale(new Date().toISOString()), false);
    assert.equal(
      cashLiquidityIsStale(new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString()),
      true,
    );
  });
});

