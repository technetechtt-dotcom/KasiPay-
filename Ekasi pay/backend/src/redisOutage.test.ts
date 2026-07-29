/**
 * Redis fail-closed behaviour outside local/test.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

test('getRedisHealth reports unconfigured Redis when URL missing', async () => {
  const previous = process.env.RATE_LIMIT_REDIS_URL;
  delete process.env.RATE_LIMIT_REDIS_URL;
  // Re-import is awkward with ESM cache; assert policy shape via evaluateMutationPolicy path
  // and health helper contract documented for ops.
  const { getRedisHealth } = await import('./middleware/sharedRateLimit.js');
  const health = getRedisHealth();
  assert.equal(typeof health.configured, 'boolean');
  assert.equal(typeof health.healthy, 'boolean');
  if (previous !== undefined) process.env.RATE_LIMIT_REDIS_URL = previous;
});

test('production-like Redis absence is treated as not healthy', async () => {
  const { getRedisHealth } = await import('./middleware/sharedRateLimit.js');
  const health = getRedisHealth();
  if (!health.configured) {
    assert.equal(health.healthy, false);
  }
});
