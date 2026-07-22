import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import { canonicalRequestHash } from './middleware/idempotencyPg.js';
import { verifyWebhookSignature } from './services/webhookInboxPg.js';

test('canonical request hash ignores object key order but not payload changes', () => {
  const first = canonicalRequestHash({ amount: '10.00', recipient: { b: 2, a: 1 } });
  const reordered = canonicalRequestHash({ recipient: { a: 1, b: 2 }, amount: '10.00' });
  const changed = canonicalRequestHash({ amount: '10.01', recipient: { a: 1, b: 2 } });
  assert.equal(first, reordered);
  assert.notEqual(first, changed);
});

test('webhook signatures are verified over exact raw bytes', () => {
  const payload = Buffer.from('{"event":"settled","amount":100}');
  const signature = createHmac('sha256', 'secret').update(payload).digest('hex');
  assert.equal(verifyWebhookSignature(payload, `sha256=${signature}`, 'secret'), true);
  assert.equal(
    verifyWebhookSignature(Buffer.from('{"event":"settled","amount":101}'), signature, 'secret'),
    false,
  );
});
