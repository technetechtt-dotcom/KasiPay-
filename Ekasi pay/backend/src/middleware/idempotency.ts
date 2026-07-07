import { randomUUID } from 'node:crypto';

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
const IN_FLIGHT_STALE_MS = 2 * 60_000;

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

type IdemRow = {
  status: number;
  response_body: string;
  created_at: string;
};

function fetchIdemRow(
  database: ReturnType<typeof getDb>,
  userId: string,
  routeName: string,
  key: string,
): IdemRow | undefined {
  return database
    .prepare(
      `SELECT status, response_body, created_at
         FROM idempotency_keys
        WHERE user_id = ? AND route = ? AND client_key = ?
          AND created_at >= ?`,
    )
    .get(userId, routeName, key, retentionFloorIso()) as IdemRow | undefined;
}

function replayCached(res: Response, hit: IdemRow): Response {
  res.setHeader('Idempotent-Replay', 'true');
  try {
    return res.status(hit.status).json(JSON.parse(hit.response_body));
  } catch {
    return res.status(hit.status).send(hit.response_body);
  }
}

function claimIdempotencyKey(
  database: ReturnType<typeof getDb>,
  userId: string,
  routeName: string,
  key: string,
): 'claimed' | 'replay' | 'in_flight' {
  const nowIso = new Date().toISOString();
  const info = database
    .prepare(
      `INSERT OR IGNORE INTO idempotency_keys
         (id, user_id, route, client_key, status, response_body, created_at)
       VALUES (?, ?, ?, ?, 0, '', ?)`,
    )
    .run(randomUUID(), userId, routeName, key, nowIso);

  if (info.changes > 0) return 'claimed';

  const hit = fetchIdemRow(database, userId, routeName, key);
  if (!hit) return 'claimed';

  if (hit.status === 0) {
    const ageMs = Date.now() - new Date(hit.created_at).getTime();
    if (ageMs > IN_FLIGHT_STALE_MS) {
      database
        .prepare(
          `DELETE FROM idempotency_keys
            WHERE user_id = ? AND route = ? AND client_key = ? AND status = 0`,
        )
        .run(userId, routeName, key);
      return claimIdempotencyKey(database, userId, routeName, key);
    }
    return 'in_flight';
  }

  return 'replay';
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
      return next();
    }
    if (key.length > MAX_KEY_LEN) {
      return res
        .status(400)
        .json({ error: `Idempotency-Key must be <= ${MAX_KEY_LEN} chars` });
    }

    const database = getDb();
    gcOldKeys(database);

    const claim = claimIdempotencyKey(
      database,
      req.auth.userId,
      routeName,
      key,
    );
    if (claim === 'in_flight') {
      res.setHeader('Retry-After', '2');
      return res.status(409).json({
        error: 'An identical request is still processing. Retry in a moment.',
      });
    }
    if (claim === 'replay') {
      const hit = fetchIdemRow(database, req.auth.userId, routeName, key);
      if (hit) return replayCached(res, hit);
      return res.status(409).json({
        error: 'Idempotency replay conflict. Retry with a new key.',
      });
    }

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
                `UPDATE idempotency_keys
                    SET status = ?, response_body = ?
                  WHERE user_id = ? AND route = ? AND client_key = ?`,
              )
              .run(
                status,
                JSON.stringify(body),
                req.auth.userId,
                routeName,
                key,
              );
          } catch {
            /* ignore */
          }
        } else if (status >= 500) {
          try {
            database
              .prepare(
                `DELETE FROM idempotency_keys
                  WHERE user_id = ? AND route = ? AND client_key = ? AND status = 0`,
              )
              .run(req.auth.userId, routeName, key);
          } catch {
            /* ignore */
          }
        }
      }
      return originalJson(body);
    };
    return next();
  };
}
