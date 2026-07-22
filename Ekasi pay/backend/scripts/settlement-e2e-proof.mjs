/**
 * Synthetic settlement end-to-end proof (no live bank files).
 *
 *   npm run settlement:e2e-proof
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  matchSettlementItem,
  parseSettlementStatement,
} from '../src/services/settlementPg.ts';
import { parseIntegerCents } from '../src/money.ts';

const root = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(root, '../fixtures/settlement/phase6-v1.sample.csv');
const content = readFileSync(fixturePath);

const parsed = parseSettlementStatement(content);
const candidates = [
  {
    id: 'cand-1',
    providerReference: 'SETTLE-REF-001',
    amountCents: parseIntegerCents('150000'),
    currency: 'ZAR',
    settlementDate: '2026-07-20',
    journalTransactionId: '00000000-0000-4000-8000-000000000001',
  },
  {
    id: 'cand-2',
    providerReference: 'SETTLE-REF-002',
    amountCents: parseIntegerCents('27000'),
    currency: 'ZAR',
    settlementDate: '2026-07-20',
    journalTransactionId: '00000000-0000-4000-8000-000000000002',
  },
];

const decisions = parsed.items.map((item) => matchSettlementItem(item, candidates));

const assertions = [
  {
    name: 'fixture_parses_phase6_v1',
    passed: parsed.items.length === 3,
    detail: `rows=${parsed.items.length}`,
  },
  {
    name: 'exact_reference_and_amount_matches',
    passed: decisions[0]?.state === 'matched',
    detail: decisions[0]?.state,
  },
  {
    name: 'partial_amount_is_suspense_candidate',
    passed: decisions[1]?.state === 'partial' || decisions[1]?.state === 'unmatched',
    detail: decisions[1]?.state,
  },
  {
    name: 'unmatched_debit_stays_open',
    passed: decisions[2]?.state === 'unmatched',
    detail: decisions[2]?.state,
  },
];

const result = {
  schemaVersion: 'phase6.settlement.e2e.v1',
  mode: 'synthetic_fixture',
  fixture: 'fixtures/settlement/phase6-v1.sample.csv',
  contentSha256: parsed.contentHash,
  canonicalSha256: parsed.canonicalHash,
  ranAt: new Date().toISOString(),
  ok: assertions.every((a) => a.passed),
  assertions,
  note: 'Live bank statement certification remains an external blocker.',
};
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 2;
