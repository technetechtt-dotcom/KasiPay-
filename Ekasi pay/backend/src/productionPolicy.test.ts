import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateMutationPolicy,
  type ProductionFeatureFlags,
} from './productionPolicy.js';
import { isMerchantOnlyRequest } from './middleware/requireApprovedMerchant.js';

const enabled: ProductionFeatureFlags = {
  financialPosting: true,
  lending: true,
  lendingDisbursement: true,
  insurance: true,
  stokvelMoneyMovement: true,
  cashSend: true,
  liveUtilities: true,
};

test('financial kill switch blocks postings but preserves reads and login', () => {
  const flags = { ...enabled, financialPosting: false };
  assert.equal(
    evaluateMutationPolicy('POST', '/transfers', flags).allowed,
    false,
  );
  assert.equal(
    evaluateMutationPolicy('GET', '/wallets/me', flags).allowed,
    true,
  );
  assert.equal(
    evaluateMutationPolicy('POST', '/login', flags).allowed,
    true,
  );
  assert.equal(
    evaluateMutationPolicy('POST', '/admin/reconciliation/run', flags).allowed,
    true,
  );
});

test('regulated product flags fail independently of global posting flag', () => {
  assert.deepEqual(
    evaluateMutationPolicy('PATCH', '/loans/abc/disburse', {
      ...enabled,
      lending: false,
      lendingDisbursement: false,
    }),
    {
      allowed: false,
      code: 'LENDING_DISABLED',
      message: 'Lending is disabled on this deployment.',
    },
  );
  assert.equal(
    evaluateMutationPolicy('POST', '/loans', {
      ...enabled,
      lending: false,
      lendingDisbursement: false,
    }).allowed,
    false,
  );
  assert.equal(
    evaluateMutationPolicy(
      'POST',
      '/insurance',
      { ...enabled, insurance: false },
      { status: 'pending' },
    ).allowed,
    false,
  );
  assert.equal(
    evaluateMutationPolicy('POST', '/insurance/policy-1/claims', {
      ...enabled,
      insurance: false,
    }).allowed,
    false,
  );
  assert.equal(
    evaluateMutationPolicy(
      'PATCH',
      '/admin/insurance/claims/claim-1',
      { ...enabled, insurance: false },
      { status: 'paid' },
    ).allowed,
    false,
  );
  assert.equal(
    evaluateMutationPolicy('POST', '/utility-purchases', {
      ...enabled,
      liveUtilities: false,
    }).allowed,
    false,
  );
  assert.equal(
    evaluateMutationPolicy('POST', '/stokvel/group-1/contributions', {
      ...enabled,
      stokvelMoneyMovement: false,
    }).allowed,
    false,
  );
  assert.equal(
    evaluateMutationPolicy('POST', '/regulated/stokvel/accounts', {
      ...enabled,
      stokvelMoneyMovement: false,
    }).allowed,
    false,
  );
  assert.equal(
    evaluateMutationPolicy('POST', '/regulated/stokvel/group-1/contributions', {
      ...enabled,
      stokvelMoneyMovement: false,
    }).allowed,
    false,
  );
  assert.equal(
    evaluateMutationPolicy(
      'POST',
      '/regulated/stokvel/group-1/withdrawals/w1/decisions',
      {
        ...enabled,
        stokvelMoneyMovement: false,
      },
    ).allowed,
    false,
  );
  assert.equal(
    evaluateMutationPolicy('POST', '/cash-send', {
      ...enabled,
      cashSend: false,
    }).allowed,
    false,
  );
  assert.equal(
    evaluateMutationPolicy('POST', '/cash-send/collect', {
      ...enabled,
      cashSend: false,
    }).allowed,
    false,
  );
  assert.equal(
    evaluateMutationPolicy('GET', '/cash-send/me', {
      ...enabled,
      cashSend: false,
    }).allowed,
    true,
  );
});

test('merchant-only policy is based on route context, not token role', () => {
  assert.equal(isMerchantOnlyRequest('/products'), true);
  assert.equal(isMerchantOnlyRequest('/insurance/abc/claims'), true);
  assert.equal(isMerchantOnlyRequest('/wallets/me'), false);
  assert.equal(isMerchantOnlyRequest('/transfers'), false);
});
