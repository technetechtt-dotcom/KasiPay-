import type { Options } from 'express-rate-limit';

import { RATE_LIMIT_REDIS_URL } from '../config.js';
import { structuredLog } from '../observability.js';

/**
 * Shared rate-limit store configuration.
 * Production multi-instance deployments should set RATE_LIMIT_REDIS_URL and
 * install a Redis store adapter. Until then we log once and use memory.
 */
let warned = false;

export function sharedRateLimitStore(): Pick<Options, 'store'> | Record<string, never> {
  if (!RATE_LIMIT_REDIS_URL) {
    if (!warned) {
      warned = true;
      structuredLog('warn', 'rate_limit.memory_only', {
        message:
          'RATE_LIMIT_REDIS_URL unset — rate limits are per-process only. Configure Redis for horizontal scale.',
      });
    }
    return {};
  }
  // Adapter hook: keep fail-closed to memory until a Redis store package is pinned.
  structuredLog('warn', 'rate_limit.redis_url_set_without_adapter', {
    message:
      'RATE_LIMIT_REDIS_URL is set but no Redis store adapter is wired yet; using memory store.',
  });
  return {};
}
