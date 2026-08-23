import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyBankDepositMatch } from './bankDepositMatchingPg.js';

describe('bank deposit matching', () => {
  it('matches exactly one merchant/reference/currency/amount row', () => {
    assert.equal(
      classifyBankDepositMatch({ exactMatches: 1, amountMatches: 0, alreadyMatched: false }),
      'matched',
    );
  });

  it('routes amount-only hits to partial and already-credited rows to duplicate', () => {
    assert.equal(
      classifyBankDepositMatch({ exactMatches: 0, amountMatches: 1, alreadyMatched: false }),
      'partial',
    );
    assert.equal(
      classifyBankDepositMatch({ exactMatches: 1, amountMatches: 0, alreadyMatched: true }),
      'duplicate',
    );
    assert.equal(
      classifyBankDepositMatch({ exactMatches: 0, amountMatches: 0, alreadyMatched: false }),
      'unmatched',
    );
  });
});
