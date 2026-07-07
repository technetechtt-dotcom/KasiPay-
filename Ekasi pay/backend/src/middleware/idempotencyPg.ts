import { randomUUID } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

import { getPgPool } from '../dbPg.js';

const KEY_HEADER = 'idempotency-key';
const RETENTION_HOURS = 24;
const MAX_KEY_LEN = 64;
/** In-flight claims older than this are treated as stale (crashed worker). */
const IN_FLIGHT_STALE_MS = 2 * 60_000;

function retentionFloorIso(): string {
  return new Date(Date.now() - RETENTION_HOURS * 3600 * 1000).toISOString();
}

async function gcOldKeys(): Promise<void> {
  const pool = getPgPool();
  try {
    await pool.query(
      `DELETE FROM idempotency_keys WHERE created_at < $1`,
      [retentionFloorIso()],
    );
  } catch {
    /* no-op */
  }
}

type IdemRow = {
  status: number;
  response_body: string;
  created_at: string;
};

async function fetchIdemRow(
  userId: string,
  routeName: string,
  key: string,
): Promise<IdemRow | null> {
  const pool = getPgPool();
  const existing = await pool.query<IdemRow>(
    `SELECT status, response_body, created_at
       FROM idempotency_keys
      WHERE user_id = $1
        AND route = $2
        AND client_key = $3
        AND created_at >= $4`,
    [userId, routeName, key, retentionFloorIso()],
  );
  return existing.rows[0] ?? null;
}

function replayCached(res: Response, hit: IdemRow): Response {
  res.setHeader('Idempotent-Replay', 'true');
  try {
    return res.status(hit.status).json(JSON.parse(hit.response_body));
  } catch {
    return res.status(hit.status).send(hit.response_body);
  }
}

async function claimIdempotencyKey(
  userId: string,
  routeName: string,
  key: string,
): Promise<'claimed' | 'replay' | 'in_flight'> {
  const pool = getPgPool();
  const nowIso = new Date().toISOString();

  const claimed = await pool.query<{ id: string }>(
    `INSERT INTO idempotency_keys
       (id, user_id, route, client_key, status, response_body, created_at)
     VALUES ($1, $2, $3, $4, 0, '', $5)
     ON CONFLICT (user_id, route, client_key) DO NOTHING
     RETURNING id`,
    [randomUUID(), userId, routeName, key, nowIso],
  );
  if (claimed.rows[0]) return 'claimed';

  const hit = await fetchIdemRow(userId, routeName, key);
  if (!hit) return 'claimed';

  if (hit.status === 0) {
    const ageMs = Date.now() - new Date(hit.created_at).getTime();
    if (ageMs > IN_FLIGHT_STALE_MS) {
      await pool.query(
        `DELETE FROM idempotency_keys
          WHERE user_id = $1 AND route = $2 AND client_key = $3 AND status = 0`,
        [userId, routeName, key],
      );
      return claimIdempotencyKey(userId, routeName, key);
    }
    return 'in_flight';
  }

  return 'replay';
}

export function idempotentPg(routeName: string) {
  return async function idempotencyMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    if (!req.auth) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const raw = req.headers[KEY_HEADER];
    const key = (Array.isArray(raw) ? raw[0] : raw ?? '').trim();
    if (!key) return next();
    if (key.length > MAX_KEY_LEN) {
      return res
        .status(400)
        .json({ error: `Idempotency-Key must be <= ${MAX_KEY_LEN} chars` });
    }

    const pool = getPgPool();
    await gcOldKeys();

    const claim = await claimIdempotencyKey(req.auth.userId, routeName, key);
    if (claim === 'in_flight') {
      res.setHeader('Retry-After', '2');
      return res.status(409).json({
        error: 'An identical request is still processing. Retry in a moment.',
      });
    }
    if (claim === 'replay') {
      const hit = await fetchIdemRow(req.auth.userId, routeName, key);
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
          void pool
            .query(
              `UPDATE idempotency_keys
                  SET status = $1, response_body = $2
                WHERE user_id = $3 AND route = $4 AND client_key = $5`,
              [
                status,
                JSON.stringify(body),
                req.auth.userId,
                routeName,
                key,
              ],
            )
            .catch(() => {
              /* ignore */
            });
        } else if (status >= 500) {
          void pool
            .query(
              `DELETE FROM idempotency_keys
                WHERE user_id = $1 AND route = $2 AND client_key = $3 AND status = 0`,
              [req.auth.userId, routeName, key],
            )
            .catch(() => {
              /* ignore */
            });
        }
      }
      return originalJson(body);
    };
    return next();
  };
}
