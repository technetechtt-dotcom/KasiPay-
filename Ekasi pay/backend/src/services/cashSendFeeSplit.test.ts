import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseIntegerCents } from '../money.js';
import { calculateFeeCents } from './feeEnginePg.js';
import { collectTimeAgentFee, createFeeReversalAmounts, createTimeFeeComponents } from './cashSendFeeSplit.js';

describe('Cash Send v3 fee split', () => {
  const fee = calculateFeeCents(parseIntegerCents('15000'), {
    id: 'cash-send-v3',
    minCents: parseIntegerCents('0', { allowZero: true }),
    maxCents: null,
    flatCents: parseIntegerCents('900'),
    rateBasisPoints: 0,
    minFeeCents: parseIntegerCents('900'),
    maxFeeCents: parseIntegerCents('900'),
    allocations: { agent: 2223, merchant: 1112, platform: 6665 },
  });

  it('splits R9 into R6 platform, R1 sending shop, R2 payout shop', () => {
    assert.equal(fee.totalFeeCents, 900n);
    assert.equal(fee.components.platform, 600n);
    assert.equal(fee.components.merchant, 100n);
    assert.equal(fee.components.agent, 200n);
  });

  it('defers the R2 payout commission until collection', () => {
    const atCreate = createTimeFeeComponents(fee.components);
    assert.equal(atCreate.merchant, 100n);
    assert.equal(atCreate.platform, 600n);
    assert.equal(atCreate.agent, 0n);
    assert.equal(collectTimeAgentFee(fee.components), 200n);
  });

  it('reverses R6 platform + R1 send on cancel/expiry, never the full R9', () => {
    const reversed = createFeeReversalAmounts({
      platformFeeCents: fee.components.platform,
      merchantCommissionCents: fee.components.merchant,
    });
    assert.equal(reversed.platform, 600n);
    assert.equal(reversed.merchant, 100n);
    assert.notEqual(reversed.platform, fee.totalFeeCents);
  });
});
