import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExternalAuditSink } from './auditSinkPg.js';
import { createHttpAuditSink } from './httpAuditSink.js';

test('HTTP audit sink posts signed payloads and fails closed on non-2xx', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const sink = createHttpAuditSink({
    endpoint: 'https://audit.example.com/v1/events',
    apiKey: 'test-audit-key',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 204 });
    },
  });

  await sink.deliver({
    id: 'evt-1',
    type: 'financial.posted',
    actorType: 'system',
    actorId: null,
    targetType: 'journal_transaction',
    targetId: 'txn-1',
    safeMetadata: { ok: true },
    requestId: 'req-1',
    correlationId: 'corr-1',
    financialReference: 'REF-1',
    createdAt: new Date().toISOString(),
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://audit.example.com/v1/events');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer test-audit-key');
  assert.ok(headers['x-audit-signature']);

  const failing: ExternalAuditSink = createHttpAuditSink({
    endpoint: 'https://audit.example.com/v1/events',
    apiKey: 'test-audit-key',
    fetchImpl: async () => new Response('nope', { status: 503 }),
  });
  await assert.rejects(
    () =>
      failing.deliver({
        id: 'evt-2',
        type: 'x',
        actorType: 'system',
        actorId: null,
        targetType: null,
        targetId: null,
        safeMetadata: {},
        requestId: null,
        correlationId: null,
        financialReference: null,
        createdAt: new Date().toISOString(),
      }),
    /audit sink HTTP 503/,
  );
});
