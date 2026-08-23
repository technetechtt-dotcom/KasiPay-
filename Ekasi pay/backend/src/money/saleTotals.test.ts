import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { computeSaleTotals } from './saleTotals.js';

describe('computeSaleTotals', () => {
  it('R100 gross R10 discount is R90 net', () => {
    const totals = computeSaleTotals(10_000n, 1_000n);
    assert.equal(totals.grossTotalCents, 10_000n);
    assert.equal(totals.discountCents, 1_000n);
    assert.equal(totals.netTotalCents, 9_000n);
  });

  it('R0 discount leaves net equal to gross', () => {
    const totals = computeSaleTotals(10_000n, 0n);
    assert.equal(totals.netTotalCents, 10_000n);
  });

  it('full discount is allowed and nets to zero', () => {
    const totals = computeSaleTotals(2_500n, 2_500n);
    assert.equal(totals.netTotalCents, 0n);
  });

  it('rejects a discount greater than the gross total', () => {
    assert.throws(
      () => computeSaleTotals(1_000n, 1_001n),
      /Discount cannot exceed the sale total/,
    );
  });
});
