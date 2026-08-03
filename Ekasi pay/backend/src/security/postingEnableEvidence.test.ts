import assert from 'node:assert/strict';
import test from 'node:test';

import { validatePostingEnableEvidence } from './postingEnableEvidence.js';

test('resume evidence requires hex release SHA', () => {
  const bad = validatePostingEnableEvidence(
    { evidenceReleaseSha: 'not-a-sha', productionReadinessPassed: true },
    '',
  );
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.code, 'POSTING_ENABLE_EVIDENCE_REQUIRED');
});

test('resume evidence requires productionReadinessPassed=true', () => {
  const bad = validatePostingEnableEvidence(
    { evidenceReleaseSha: 'a48a898', productionReadinessPassed: false },
    '',
  );
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.code, 'POSTING_ENABLE_READINESS_REQUIRED');
});

test('resume evidence mismatches runtime release SHA', () => {
  const bad = validatePostingEnableEvidence(
    { evidenceReleaseSha: 'a48a898deadbeef', productionReadinessPassed: true },
    'ffffffffffffffff',
  );
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.code, 'POSTING_ENABLE_EVIDENCE_MISMATCH');
});

test('resume evidence accepts matching SHA and readiness', () => {
  const ok = validatePostingEnableEvidence(
    {
      evidenceReleaseSha: 'a48a898deadbeef',
      productionReadinessPassed: true,
    },
    'a48a898deadbeef',
  );
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.evidenceSha, 'a48a898deadbeef');
});
