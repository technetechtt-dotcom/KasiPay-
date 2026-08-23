import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { netSettlementPosition } from './settlementNettingPg.js';

describe('merchant settlement netting', () => {
  it('nets cash-in R10000 against cash-out R7000 to R3000', () => {
    assert.equal(
      netSettlementPosition({
        openingCents: 0n,
        cashInCents: 1_000_000n,
        cashOutCents: 700_000n,
        walletInflowCents: 0n,
        walletOutflowCents: 0n,
        commissionCents: 0n,
        feesCents: 0n,
        adjustmentsCents: 0n,
      }),
      300_000n,
    );
  });
});
