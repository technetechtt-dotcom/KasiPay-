import assert from 'node:assert/strict';
import test from 'node:test';

import { parseIntegerCents } from './money.js';
import { calculateFeeCents } from './services/feeEnginePg.js';
import {
  boundedRetryDelayMs,
  ProviderSimulator,
  providerPayloadHash,
  signProviderRequest,
  verifyProviderCallback,
} from './services/providerFrameworkPg.js';
import {
  matchSettlementItem,
  parseSettlementStatement,
} from './services/settlementPg.js';

const statement = Buffer.from(
  'provider_reference,bank_reference,amount_cents,currency,value_date,direction\n' +
  'PAY-1,BANK-1,1250,ZAR,2026-07-20,credit\n',
);

test('statement parser is strict, hashed and duplicate-safe', () => {
  const parsed = parseSettlementStatement(statement);
  assert.equal(parsed.items[0]?.amountCents, 1250n);
  assert.match(parsed.contentHash, /^[0-9a-f]{64}$/);
  assert.throws(
    () => parseSettlementStatement(Buffer.concat([statement, Buffer.from('PAY-1,BANK-1,1250,ZAR,2026-07-20,credit\n')])),
    /Duplicate row/,
  );
  assert.throws(
    () => parseSettlementStatement(Buffer.from(statement.toString().replace('amount_cents', 'amount'))),
    /Invalid statement header/,
  );
});

test('settlement matching is deterministic for exact, partial, duplicate and unmatched', () => {
  const item = parseSettlementStatement(statement).items[0]!;
  const candidate = {
    id: 'payout-1',
    providerReference: 'PAY-1',
    amountCents: parseIntegerCents('1250'),
    currency: 'ZAR',
    settlementDate: '2026-07-20',
    journalTransactionId: 'journal-1',
  };
  assert.equal(matchSettlementItem(item, [candidate]).state, 'matched');
  assert.equal(
    matchSettlementItem(item, [{ ...candidate, amountCents: parseIntegerCents('1500') }]).state,
    'partial',
  );
  assert.equal(matchSettlementItem(item, [candidate, { ...candidate, id: 'payout-2' }]).state, 'duplicate');
  assert.equal(matchSettlementItem(item, []).state, 'unmatched');
});

test('fee versions calculate integer cents and exact allocations', () => {
  const fee = calculateFeeCents(parseIntegerCents('10001'), {
    id: 'tier',
    minCents: parseIntegerCents('1'),
    maxCents: null,
    flatCents: parseIntegerCents('100'),
    rateBasisPoints: 250,
    minFeeCents: parseIntegerCents('0', { allowZero: true }),
    maxFeeCents: null,
    allocations: { platform: 5000, provider: 2000, tax: 1500, agent: 1500 },
  });
  assert.equal(fee.totalFeeCents, 350n);
  assert.equal(Object.values(fee.components).reduce((sum, value) => sum + value, 0n), 350n);
  assert.throws(
    () => calculateFeeCents(parseIntegerCents('100'), {
      id: 'bad', minCents: 1n, maxCents: null, flatCents: 1n,
      rateBasisPoints: 0, minFeeCents: 0n, maxFeeCents: null,
      allocations: { platform: 9999 },
    }),
    /10000/,
  );
});

test('provider signing rejects stale callbacks and payload changes', () => {
  const now = new Date('2026-07-21T10:00:00Z');
  const timestamp = now.toISOString();
  const payload = { eventId: 'evt-1', state: 'fulfilled' };
  const signature = signProviderRequest('secret', timestamp, providerPayloadHash(payload));
  assert.equal(verifyProviderCallback({ secret: 'secret', timestamp, payload, signature, now }), true);
  assert.equal(
    verifyProviderCallback({ secret: 'secret', timestamp, payload: { ...payload, state: 'failed' }, signature, now }),
    false,
  );
  assert.equal(
    verifyProviderCallback({
      secret: 'secret',
      timestamp: '2026-07-21T09:00:00Z',
      payload,
      signature,
      now,
    }),
    false,
  );
});

test('provider simulator is idempotent and unknown outcomes recover by query', async () => {
  const simulator = new ProviderSimulator('unknown_then_fulfilled');
  const first = await simulator.submit({
    instructionId: 'i',
    idempotencyKey: 'same-key',
    payload: {},
    signature: '',
    timestamp: new Date().toISOString(),
  });
  assert.equal(first.state, 'unknown');
  const recovered = await simulator.query(first.providerReference!);
  assert.equal(recovered.state, 'fulfilled');
  const duplicate = await simulator.submit({
    instructionId: 'i2',
    idempotencyKey: 'same-key',
    payload: { changed: true },
    signature: '',
    timestamp: new Date().toISOString(),
  });
  assert.equal(duplicate.providerReference, first.providerReference);
  assert.equal(boundedRetryDelayMs(1, 0), 187);
  assert.ok(boundedRetryDelayMs(20, 1) <= 37_500);
});
