import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REQUIRED_READINESS_CONTROLS,
  canonicalEvidenceDigest,
  productConfigEnabled,
} from './productReadiness.js';
import {
  allocateLoanRepayment,
  assessAffordability,
  calculateLoanSchedule,
  stableJsonSha256,
} from './services/regulatedProducts.js';

test('readiness requires every Phase 7 control category', () => {
  assert.deepEqual(REQUIRED_READINESS_CONTROLS, [
    'legal',
    'provider',
    'accounting',
    'customer_journey',
    'reconciliation',
    'testing',
    'runbook',
  ]);
});

test('production readiness requires global and product config gates', () => {
  const originalGlobal = process.env.REGULATED_PRODUCTS_PRODUCTION_ENABLED;
  const originalProduct = process.env.PRODUCT_LENDING_PRODUCTION_ENABLED;
  try {
    process.env.REGULATED_PRODUCTS_PRODUCTION_ENABLED = 'true';
    delete process.env.PRODUCT_LENDING_PRODUCTION_ENABLED;
    assert.equal(productConfigEnabled('lending', 'production'), false);
    process.env.PRODUCT_LENDING_PRODUCTION_ENABLED = 'true';
    assert.equal(productConfigEnabled('lending', 'production'), true);
  } finally {
    if (originalGlobal === undefined) delete process.env.REGULATED_PRODUCTS_PRODUCTION_ENABLED;
    else process.env.REGULATED_PRODUCTS_PRODUCTION_ENABLED = originalGlobal;
    if (originalProduct === undefined) delete process.env.PRODUCT_LENDING_PRODUCTION_ENABLED;
    else process.env.PRODUCT_LENDING_PRODUCTION_ENABLED = originalProduct;
  }
});

test('evidence digest binds authority, artifact and decision', () => {
  const base = {
    product: 'insurance' as const,
    environment: 'production' as const,
    control: 'legal' as const,
    decision: 'approved' as const,
    authority: 'External counsel',
    artifactUri: 'vault://legal/opinion-1',
    artifactSha256: 'a'.repeat(64),
    notes: 'Recorded evidence only; not a platform legal representation.',
  };
  assert.notEqual(
    canonicalEvidenceDigest(base),
    canonicalEvidenceDigest({ ...base, artifactSha256: 'b'.repeat(64) }),
  );
});

test('loan schedule is deterministic and preserves every cent', () => {
  const schedule = calculateLoanSchedule({
    principalCents: 10_001n,
    interestBps: 1_250,
    initiationFeeCents: 151n,
    serviceFeeCents: 25n,
    termCount: 3,
    firstDueDate: '2026-01-31',
    termUnit: 'month',
  });
  assert.equal(
    schedule.items.reduce((sum, item) => sum + item.principalCents, 0n),
    10_001n,
  );
  assert.equal(
    schedule.items.reduce((sum, item) => sum + item.totalCents, 0n),
    schedule.totalCents,
  );
  assert.deepEqual(schedule.items.map((item) => item.dueDate), [
    '2026-01-31',
    '2026-02-28',
    '2026-03-31',
  ]);
});

test('repayment waterfall allocates fee then interest then principal', () => {
  assert.deepEqual(
    allocateLoanRepayment({
      paymentCents: 700n,
      feeOutstandingCents: 100n,
      interestOutstandingCents: 200n,
      principalOutstandingCents: 1_000n,
    }),
    {
      allocations: [
        { component: 'fee', amountCents: 100n, sequence: 1 },
        { component: 'interest', amountCents: 200n, sequence: 2 },
        { component: 'principal', amountCents: 400n, sequence: 3 },
      ],
      unappliedCents: 0n,
    },
  );
});

test('affordability keeps inputs and decision deterministic', () => {
  assert.deepEqual(
    assessAffordability({
      incomeCents: 100_000n,
      expenseCents: 60_000n,
      existingDebtCents: 10_000n,
      proposedInstallmentCents: 20_000n,
      minimumBufferCents: 5_000n,
    }),
    { disposableCents: 30_000n, eligible: true },
  );
});

test('stable JSON digest is independent of object key order', () => {
  assert.equal(stableJsonSha256({ b: 2, a: 1 }), stableJsonSha256({ a: 1, b: 2 }));
});
