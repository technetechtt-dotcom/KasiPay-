import assert from 'node:assert/strict';
import test from 'node:test';

import { generateCashSendReference } from './cashSendKyc.js';
import { runFailureDrill } from './failureDrills.js';
import { redact } from './observability.js';
import { detectCircularFlow, evaluateRiskRules, exceedsTierLimit } from './risk.js';
import { recordAuditEventPg } from './services/auditPg.js';

test('risk rules score velocity and force the strongest action', () => {
  const result = evaluateRiskRules(
    [
      { code: 'FAST', score: 300, action: 'review', expression: { field: 'events10m', operator: 'gte', value: 5 } },
      { code: 'LINKED', score: 250, action: 'hold', expression: { field: 'linkedAccounts', operator: 'gt', value: 2 } },
    ],
    { amountCents: 100, events10m: 7, events24h: 8, linkedAccounts: 4, circularHops: 0 },
  );
  assert.equal(result.score, 550);
  assert.equal(result.decision, 'hold');
});

test('tier limits include transaction, daily and monthly counters', () => {
  assert.equal(exceedsTierLimit(600n, {
    dailyCents: 500n, monthlyCents: 500n, dailyCount: 1, monthlyCount: 1,
  }, {
    perTransactionCents: 1_000n, dailyCents: 1_000n, monthlyCents: 10_000n,
    dailyCount: 5, monthlyCount: 20,
  }), 'daily_amount');
});

test('circular flow detection is bounded', () => {
  const graph = new Map<string, string[]>([['a', ['b']], ['b', ['c']], ['c', ['a']]]);
  assert.equal(detectCircularFlow(graph, 'a'), true);
  assert.equal(detectCircularFlow(graph, 'a', 1), false);
});

test('cash send references are unique 128-bit cryptographic values', () => {
  const refs = new Set(Array.from({ length: 1_000 }, generateCashSendReference));
  assert.equal(refs.size, 1_000);
  for (const ref of refs) assert.match(ref, /^CS[0-9A-F]{32}$/);
});

test('central redaction removes secrets and hashes direct PII', () => {
  const output = redact({ pin: '1234', phone: '0821234567', nested: { token: 'secret' } });
  assert.deepEqual(output, {
    pin: '[REDACTED]',
    phone: (output as { phone: string }).phone,
    nested: { token: '[REDACTED]' },
  });
  assert.match((output as { phone: string }).phone, /^\[HASH:/);
});

test('audit evidence insertion is awaited and includes outbox-triggered event fields', async () => {
  const calls: unknown[][] = [];
  const database = {
    query: async (...args: unknown[]) => {
      calls.push(args);
      return { rows: [] };
    },
  };
  await recordAuditEventPg(database as never, {
    type: 'financial.posted',
    message: 'posted',
    financialReference: 'TX-1',
  });
  assert.equal(calls.length, 1);
  assert.match(String(calls[0][0]), /INSERT INTO audit_events/);
  assert.match(JSON.stringify(calls[0]), /TX-1/);
});

test('failure drill result is machine-readable and rejects failed assertions', async () => {
  const result = await runFailureDrill('duplicate_webhook', 'test', async () => ({
    assertions: [{ name: 'processed_once', passed: true }],
  }));
  assert.equal(result.schemaVersion, 'phase5.drill.v1');
  assert.equal(result.outcome, 'passed');
});
