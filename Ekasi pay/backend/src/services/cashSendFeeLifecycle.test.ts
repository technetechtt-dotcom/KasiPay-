import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseIntegerCents } from '../money.js';
import { calculateFeeCents } from './feeEnginePg.js';
import {
  collectTimeAgentFee,
  createFeeReversalAmounts,
  createTimeFeeComponents,
} from './cashSendFeeSplit.js';
import { platformFeeSweepable } from './feeLifecyclePg.js';

describe('Cash Send R6/R1/R2 lifecycle', () => {
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

  it('create accrues R6 platform + R1 send and holds R2', () => {
    const created = createTimeFeeComponents(fee.components);
    assert.equal(created.platform, 600n);
    assert.equal(created.merchant, 100n);
    assert.equal(created.agent, 0n);
  });

  it('collect posts R2 agent and makes platform sweepable', () => {
    assert.equal(collectTimeAgentFee(fee.components), 200n);
    assert.equal(
      platformFeeSweepable({ voucherStatus: 'collected', component: 'platform' }),
      true,
    );
    assert.equal(
      platformFeeSweepable({ voucherStatus: 'active', component: 'platform' }),
      false,
    );
  });

  it('cancel and expiry reverse R6+R1 only', () => {
    const reversed = createFeeReversalAmounts({
      platformFeeCents: '600',
      merchantCommissionCents: '100',
    });
    assert.equal(reversed.platform + reversed.merchant, 700n);
    assert.equal(reversed.platform + reversed.merchant + collectTimeAgentFee(fee.components), 900n);
  });
});
