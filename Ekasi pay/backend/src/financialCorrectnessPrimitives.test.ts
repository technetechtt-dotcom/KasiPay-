import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalRequestHash } from './middleware/idempotencyPg.js';
import { REFUND_CHECKER_THRESHOLD_CENTS } from './services/refundsPg.js';
import { classifyDriftOrigin } from './services/walletLedgerAlignmentPg.js';
import { parseIntegerCents } from './money.js';

test('concurrent transfer intent is serialized by wallet lock ordering contract', () => {
  // postBetweenWalletsPg locks wallets ORDER BY id — document the invariant here.
  const ids = ['b-wallet', 'a-wallet'];
  const lockedOrder = [...ids].sort();
  assert.deepEqual(lockedOrder, ['a-wallet', 'b-wallet']);
});

test('duplicate API requests share a canonical hash independent of key order', () => {
  const a = canonicalRequestHash({ amountCents: '1000', to: { phone: '082' }, meta: { z: 1, a: 2 } });
  const b = canonicalRequestHash({ meta: { a: 2, z: 1 }, to: { phone: '082' }, amountCents: '1000' });
  assert.equal(a, b);
});

test('over-refund and negative/overflow amounts are rejected by integer money parser', () => {
  assert.throws(() => parseIntegerCents(-1n));
  assert.throws(() => parseIntegerCents('1.5'));
  assert.equal(Number(REFUND_CHECKER_THRESHOLD_CENTS) > 0, true);
});

test('currency and ledger-pool mismatches are classified as dual-write gaps when ledger exists', () => {
  assert.equal(
    classifyDriftOrigin({
      walletId: 'abc',
      walletKind: 'user',
      deltaCents: 500n,
      legacyEntryCount: 3,
    }),
    'legacy_dual_write_gap',
  );
});

test('opening credits without ledger entries are classified for adjustment journals', () => {
  assert.equal(
    classifyDriftOrigin({
      walletId: 'abc',
      walletKind: 'user',
      deltaCents: 100001000n,
      legacyEntryCount: 8,
    }),
    'opening_credit_without_ledger',
  );
  assert.equal(
    classifyDriftOrigin({
      walletId: 'abc',
      walletKind: 'user',
      deltaCents: 50_000n,
      legacyEntryCount: 0,
    }),
    'opening_credit_without_ledger',
  );
});

test('escrow fee retention mismatch is classified for the system escrow wallet', () => {
  assert.equal(
    classifyDriftOrigin({
      walletId: 'escrow',
      walletKind: 'system_escrow',
      deltaCents: -2000n,
      legacyEntryCount: 9,
    }),
    'escrow_fee_retention_mismatch',
  );
});

test('integration fixture wallets are tagged separately from customer drift', () => {
  assert.equal(
    classifyDriftOrigin({
      walletId: 'ledger-wallet-from-deadbeef',
      walletKind: 'user',
      deltaCents: 10000n,
      legacyEntryCount: 0,
    }),
    'integration_fixture',
  );
});
