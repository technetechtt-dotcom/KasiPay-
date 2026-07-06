import type { NextFunction, Request, Response } from 'express';

import { getDb } from '../db.js';

/**
 * Idempotency cache for hot POSTs. The client should send an `Idempotency-Key`
 * header (any UUID-shaped string is fine, max 64 chars). If we have already
 * processed the same `(user, route, key)` tuple within the retention window
 * we replay the cached status + body verbatim.
 *
 * Cached responses are stored only on 2xx + 4xx (so retries see consistent
 * validation failures too). 5xx responses are *not* cached because the request
 * may have been partially applied and replays should be allowed to retry.
 */
const KEY_HEADER = 'idempotency-key';
const RETENTION_HOURS = 24;
const MAX_KEY_LEN = 64;

/** ISO timestamp `RETENTION_HOURS` ago. */
function retentionFloorIso(): string {
  return new Date(Date.now() - RETENTION_HOURS * 3600 * 1000).toISOString();
}

/** Strip stale rows opportunistically; keeps the table small. */
function gcOldKeys(database = getDb()): void {
  try {
    database
      .prepare(`DELETE FROM idempotency_keys WHERE created_at < ?`)
      .run(retentionFloorIso());
  } catch {
    /* table missing in test scenarios — caller already runs the migration */
  }
}

/**
 * `routeName` is a stable string (e.g. `'POST /sales'`) used to scope the key
 * per endpoint. Without it, replaying the same key to two different routes
 * would collide.
 */
export function idempotent(routeName: string) {
  return function idempotencyMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    if (!req.auth) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const raw = req.headers[KEY_HEADER];
    const key = (Array.isArray(raw) ? raw[0] : raw ?? '').trim();
    if (!key) {
      // No header → no replay protection, but still proceed (backwards compat).
      return next();
    }
    if (key.length > MAX_KEY_LEN) {
      return res
        .status(400)
        .json({ error: `Idempotency-Key must be <= ${MAX_KEY_LEN} chars` });
    }

    const database = getDb();
    gcOldKeys(database);
    const existing = database
      .prepare(
        `SELECT status, response_body
           FROM idempotency_keys
          WHERE user_id = ? AND route = ? AND client_key = ?
            AND created_at >= ?`,
      )
      .get(req.auth.userId, routeName, key, retentionFloorIso()) as
      | { status: number; response_body: string }
      | undefined;

    if (existing) {
      res.setHeader('Idempotent-Replay', 'true');
      try {
        return res.status(existing.status).json(JSON.parse(existing.response_body));
      } catch {
        return res.status(existing.status).send(existing.response_body);
      }
    }

    // Capture the next `res.json` call so we can cache the response. We only
    // wrap `.json` because every route in this app responds with JSON.
    const originalJson = res.json.bind(res);
    let cached = false;
    res.json = function cachingJson(body: unknown) {
      if (!cached && req.auth) {
        cached = true;
        const status = res.statusCode || 200;
        if (status >= 200 && status < 500) {
          try {
            database
              .prepare(
                `INSERT INTO idempotency_keys
                   (id, user_id, route, client_key, status, response_body, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                `idem_${Date.now().toString(36)}_${Math.random()
                  .toString(36)
                  .slice(2, 10)}`,
                req.auth.userId,
                routeName,
                key,
                status,
                JSON.stringify(body),
                new Date().toISOString(),
              );
          } catch {
            // Race-condition with a concurrent retry — safe to ignore; the
            // unique index protects against duplicates.
          }
        }
      }
      return originalJson(body);
    };
    return next();
  };
}
