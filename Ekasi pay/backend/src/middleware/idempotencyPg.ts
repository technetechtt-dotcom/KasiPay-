import { randomUUID } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

import { getPgPool } from '../dbPg.js';

const KEY_HEADER = 'idempotency-key';
const RETENTION_HOURS = 24;
const MAX_KEY_LEN = 64;

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

    const existing = await pool.query<{ status: number; response_body: string }>(
      `SELECT status, response_body
         FROM idempotency_keys
        WHERE user_id = $1
          AND route = $2
          AND client_key = $3
          AND created_at >= $4`,
      [req.auth.userId, routeName, key, retentionFloorIso()],
    );
    const hit = existing.rows[0];
    if (hit) {
      res.setHeader('Idempotent-Replay', 'true');
      try {
        return res.status(hit.status).json(JSON.parse(hit.response_body));
      } catch {
        return res.status(hit.status).send(hit.response_body);
      }
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
              `INSERT INTO idempotency_keys
                 (id, user_id, route, client_key, status, response_body, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [
                randomUUID(),
                req.auth.userId,
                routeName,
                key,
                status,
                JSON.stringify(body),
                new Date().toISOString(),
              ],
            )
            .catch(() => {
              /* race-safe ignore */
            });
        }
      }
      return originalJson(body);
    };
    return next();
  };
}
