import type { Options } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { createClient, type RedisClientType } from 'redis';

import { IS_LOCAL_ENV, RATE_LIMIT_REDIS_URL } from '../config.js';
import { structuredLog } from '../observability.js';

/**
 * Shared rate-limit store for multi-instance deployments.
 * Outside local development/test, Redis is mandatory — never silently fall back
 * to per-process memory counters for login/OTP/PIN-reset or payment limits.
 */
let warnedMemory = false;
let redisClientPromise: Promise<RedisClientType> | null = null;
let redisHealthy = false;
let lastRedisError: string | null = null;

export function getRedisHealth(): {
  configured: boolean;
  healthy: boolean;
  lastError: string | null;
} {
  return {
    configured: Boolean(RATE_LIMIT_REDIS_URL),
    healthy: redisHealthy,
    lastError: lastRedisError,
  };
}

export async function pingRateLimitRedis(): Promise<boolean> {
  if (!RATE_LIMIT_REDIS_URL) return false;
  const client = await redisClient();
  const pong = await client.ping();
  redisHealthy = pong === 'PONG';
  if (!redisHealthy) lastRedisError = `unexpected ping response: ${pong}`;
  return redisHealthy;
}

function redisClient(): Promise<RedisClientType> {
  if (!RATE_LIMIT_REDIS_URL) {
    throw new Error('RATE_LIMIT_REDIS_URL is not configured.');
  }
  if (!redisClientPromise) {
    redisClientPromise = (async () => {
      const client = createClient({ url: RATE_LIMIT_REDIS_URL });
      client.on('error', (err) => {
        redisHealthy = false;
        lastRedisError = err instanceof Error ? err.message : 'redis error';
        structuredLog('error', 'rate_limit.redis_error', {
          message: lastRedisError,
          alert: true,
        });
      });
      client.on('ready', () => {
        redisHealthy = true;
        lastRedisError = null;
        structuredLog('info', 'rate_limit.redis_connected', {
          message: 'Shared rate-limit store connected.',
        });
      });
      client.on('end', () => {
        redisHealthy = false;
        lastRedisError = 'connection ended';
        structuredLog('error', 'rate_limit.redis_disconnected', {
          message: 'Redis rate-limit connection lost.',
          alert: true,
        });
      });
      await client.connect();
      redisHealthy = true;
      return client as RedisClientType;
    })();
  }
  return redisClientPromise;
}

/**
 * @param prefix Unique per limiter (required — stores must not be shared).
 * @param options.failClosed When true (default outside local), refuse memory fallback.
 */
export function sharedRateLimitStore(
  prefix: string,
  options: { failClosed?: boolean } = {},
): Pick<Options, 'store'> | Record<string, never> {
  if (!prefix.trim()) {
    throw new Error('sharedRateLimitStore requires a non-empty prefix.');
  }
  const failClosed = options.failClosed ?? !IS_LOCAL_ENV;
  if (!RATE_LIMIT_REDIS_URL) {
    if (failClosed) {
      throw new Error(
        'RATE_LIMIT_REDIS_URL is required outside development/test — refusing per-process rate-limit fallback.',
      );
    }
    if (!warnedMemory) {
      warnedMemory = true;
      structuredLog('warn', 'rate_limit.memory_only', {
        message:
          'RATE_LIMIT_REDIS_URL unset — rate limits are per-process only (local only).',
      });
    }
    return {};
  }
  return {
    store: new RedisStore({
      prefix: `rl:${prefix}:`,
      sendCommand: async (...args: string[]) => {
        try {
          const client = await redisClient();
          return client.sendCommand(args);
        } catch (error) {
          redisHealthy = false;
          lastRedisError = error instanceof Error ? error.message : 'redis send failed';
          structuredLog('error', 'rate_limit.redis_command_failed', {
            message: lastRedisError,
            alert: true,
            failClosed: true,
          });
          // Fail closed for auth and high-risk limiters — do not fall back to memory.
          throw Object.assign(new Error('Rate limit store unavailable.'), {
            status: 503,
            code: 'RATE_LIMIT_REDIS_UNAVAILABLE',
          });
        }
      },
    }),
  };
}
