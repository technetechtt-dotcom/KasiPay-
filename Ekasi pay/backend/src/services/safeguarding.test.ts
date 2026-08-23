import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifySafeguarding } from './safeguardingPg.js';

describe('safeguarding classification', () => {
  it('is balanced when bank equals expected client funds', () => {
    assert.deepEqual(
      classifySafeguarding({ expectedClientFundsCents: 10_000n, actualClientFundsCents: 10_000n }),
      { status: 'balanced', differenceCents: 0n },
    );
  });

  it('is a shortfall when the bank is below expected liabilities', () => {
    assert.deepEqual(
      classifySafeguarding({ expectedClientFundsCents: 10_000n, actualClientFundsCents: 9_000n }),
      { status: 'shortfall', differenceCents: -1_000n },
    );
  });

  it('is a surplus when the bank is above expected liabilities', () => {
    assert.deepEqual(
      classifySafeguarding({ expectedClientFundsCents: 10_000n, actualClientFundsCents: 12_000n }),
      { status: 'surplus', differenceCents: 2_000n },
    );
  });

  it('is unknown when no bank balance is supplied', () => {
    assert.deepEqual(
      classifySafeguarding({ expectedClientFundsCents: 10_000n, actualClientFundsCents: null }),
      { status: 'unknown', differenceCents: null },
    );
  });
});
