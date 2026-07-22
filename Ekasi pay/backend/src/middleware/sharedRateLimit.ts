import type { Options } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { createClient, type RedisClientType } from 'redis';

import { RATE_LIMIT_REDIS_URL } from '../config.js';
import { structuredLog } from '../observability.js';

/**
 * Shared rate-limit store for multi-instance deployments.
 * When RATE_LIMIT_REDIS_URL is unset, express-rate-limit keeps its memory store.
 */
let warnedMemory = false;
let redisClientPromise: Promise<RedisClientType> | null = null;

function redisClient(): Promise<RedisClientType> {
  if (!RATE_LIMIT_REDIS_URL) {
    throw new Error('RATE_LIMIT_REDIS_URL is not configured.');
  }
  if (!redisClientPromise) {
    redisClientPromise = (async () => {
      const client = createClient({ url: RATE_LIMIT_REDIS_URL });
      client.on('error', (err) => {
        structuredLog('error', 'rate_limit.redis_error', {
          message: err instanceof Error ? err.message : 'redis error',
        });
      });
      await client.connect();
      structuredLog('info', 'rate_limit.redis_connected', {
        message: 'Shared rate-limit store connected.',
      });
      return client as RedisClientType;
    })();
  }
  return redisClientPromise;
}

/**
 * @param prefix Unique per limiter (required — stores must not be shared).
 */
export function sharedRateLimitStore(prefix: string): Pick<Options, 'store'> | Record<string, never> {
  if (!prefix.trim()) {
    throw new Error('sharedRateLimitStore requires a non-empty prefix.');
  }
  if (!RATE_LIMIT_REDIS_URL) {
    if (!warnedMemory) {
      warnedMemory = true;
      structuredLog('warn', 'rate_limit.memory_only', {
        message:
          'RATE_LIMIT_REDIS_URL unset — rate limits are per-process only. Configure Redis for horizontal scale.',
      });
    }
    return {};
  }
  return {
    store: new RedisStore({
      prefix: `rl:${prefix}:`,
      sendCommand: async (...args: string[]) => {
        const client = await redisClient();
        return client.sendCommand(args);
      },
    }),
  };
}
