import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

import type { NextFunction, Request, Response } from 'express';

import { getPgPool } from '../dbPg.js';

const KEY_HEADER = 'idempotency-key';
const MAX_KEY_LEN = 64;
const IN_FLIGHT_LEASE_MS = 2 * 60_000;

export type PaymentIdempotencyContext = {
  actorId: string;
  route: string;
  key: string;
  requestHash: string;
};
const paymentContext = new AsyncLocalStorage<PaymentIdempotencyContext>();

export function currentPaymentIdempotency(): PaymentIdempotencyContext | undefined {
  return paymentContext.getStore();
}

type IdemRow = {
  lifecycle: 'in_flight' | 'completed' | 'failed';
  request_hash: string;
  response_status: number | null;
  response_body: unknown;
  locked_until: string;
  posting_id: string | null;
  financial_reference: string | null;
};

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
    .join(',')}}`;
}

export function canonicalRequestHash(body: unknown): string {
  return createHash('sha256').update(canonicalize(body)).digest('hex');
}

async function fetchIdemRow(
  actorId: string,
  routeName: string,
  key: string,
): Promise<IdemRow | null> {
  const pool = getPgPool();
  const existing = await pool.query<IdemRow>(
    `SELECT lifecycle, request_hash, response_status, response_body, locked_until,
            posting_id, financial_reference
       FROM payment_idempotency
      WHERE actor_id = $1
        AND route = $2
        AND client_key = $3`,
    [actorId, routeName, key],
  );
  return existing.rows[0] ?? null;
}

function recoveryBody(hit: IdemRow): Record<string, unknown> {
  if (
    hit.response_body &&
    typeof hit.response_body === 'object' &&
    !Array.isArray(hit.response_body)
  ) {
    return hit.response_body as Record<string, unknown>;
  }
  return {
    recovered: true,
    transactionId: hit.posting_id,
    reference: hit.financial_reference,
  };
}

function replayCached(res: Response, hit: IdemRow): Response {
  res.setHeader('Idempotent-Replay', 'true');
  return res.status(hit.response_status ?? 200).json(recoveryBody(hit));
}

/**
 * If money already posted under this key but the HTTP response was never
 * persisted (crash after commit), seal the row as completed and replay.
 * Never reclaim a lease that already has a posting_id.
 */
async function recoverPostedWithoutResponse(
  actorId: string,
  routeName: string,
  key: string,
  requestHash: string,
  hit: IdemRow,
): Promise<IdemRow | null> {
  if (!hit.posting_id) return null;
  const pool = getPgPool();
  const body = recoveryBody(hit);
  const status = hit.response_status && hit.response_status >= 200 ? hit.response_status : 200;
  await pool.query(
    `UPDATE payment_idempotency
        SET lifecycle = 'completed',
            response_status = COALESCE(response_status, $1),
            response_body = COALESCE(response_body, $2::jsonb),
            completed_at = COALESCE(completed_at, clock_timestamp()),
            updated_at = clock_timestamp()
      WHERE actor_id = $3 AND route = $4 AND client_key = $5
        AND request_hash = $6 AND posting_id IS NOT NULL`,
    [status, JSON.stringify(body), actorId, routeName, key, requestHash],
  );
  return fetchIdemRow(actorId, routeName, key);
}

async function claimIdempotencyKey(
  actorId: string,
  routeName: string,
  key: string,
  requestHash: string,
): Promise<'claimed' | 'replay' | 'in_flight' | 'mismatch'> {
  const pool = getPgPool();
  const lockedUntil = new Date(Date.now() + IN_FLIGHT_LEASE_MS).toISOString();

  const claimed = await pool.query<{ id: string }>(
    `INSERT INTO payment_idempotency
       (id, actor_id, route, client_key, request_hash, lifecycle, locked_until)
     VALUES ($1, $2, $3, $4, $5, 'in_flight', $6)
     ON CONFLICT (actor_id, route, client_key) DO NOTHING
     RETURNING id`,
    [randomUUID(), actorId, routeName, key, requestHash, lockedUntil],
  );
  if (claimed.rows[0]) return 'claimed';

  const hit = await fetchIdemRow(actorId, routeName, key);
  if (!hit) return claimIdempotencyKey(actorId, routeName, key, requestHash);
  if (hit.request_hash !== requestHash) return 'mismatch';
  if (hit.lifecycle === 'completed') return 'replay';

  // Crash-after-post: money moved, response missing — recover, never re-post.
  if (hit.posting_id) {
    const recovered = await recoverPostedWithoutResponse(
      actorId,
      routeName,
      key,
      requestHash,
      hit,
    );
    if (recovered?.lifecycle === 'completed') return 'replay';
    return 'in_flight';
  }

  if (new Date(hit.locked_until).getTime() <= Date.now()) {
    // Only reclaim leases that never produced a financial posting.
    const reclaimed = await pool.query(
      `UPDATE payment_idempotency
          SET lifecycle = 'in_flight', locked_until = $1, updated_at = clock_timestamp(),
              response_status = NULL, response_body = NULL
        WHERE actor_id = $2 AND route = $3 AND client_key = $4
          AND request_hash = $5
          AND locked_until <= clock_timestamp()
          AND posting_id IS NULL
        RETURNING id`,
      [lockedUntil, actorId, routeName, key, requestHash],
    );
    return reclaimed.rows[0] ? 'claimed' : 'in_flight';
  }
  return 'in_flight';
}

export function idempotentPg(routeName: string) {
  return async function idempotencyMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    const actorId = req.auth?.userId ?? (req.opsAuth ? `ops:${req.opsAuth.operatorId}` : null);
    if (!actorId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const raw = req.headers[KEY_HEADER];
    const key = (Array.isArray(raw) ? raw[0] : raw ?? '').trim();
    if (!key) {
      return res.status(400).json({ error: 'Idempotency-Key is required' });
    }
    if (key.length > MAX_KEY_LEN) {
      return res
        .status(400)
        .json({ error: `Idempotency-Key must be <= ${MAX_KEY_LEN} chars` });
    }

    const pool = getPgPool();
    const requestHash = canonicalRequestHash(req.body);
    const claim = await claimIdempotencyKey(
      actorId,
      routeName,
      key,
      requestHash,
    );
    if (claim === 'mismatch') {
      return res.status(422).json({
        error: 'Idempotency-Key was already used with a different request payload.',
      });
    }
    if (claim === 'in_flight') {
      res.setHeader('Retry-After', '2');
      return res.status(409).json({
        error: 'An identical request is still processing. Retry in a moment.',
      });
    }
    if (claim === 'replay') {
      const hit = await fetchIdemRow(actorId, routeName, key);
      if (hit) return replayCached(res, hit);
      return res.status(409).json({
        error: 'Idempotency replay conflict. Retry with a new key.',
      });
    }

    const originalJson = res.json.bind(res);
    let cached = false;
    res.json = function cachingJson(body: unknown) {
      if (!cached) {
        cached = true;
        const status = res.statusCode || 200;
        let persistence: Promise<unknown> | undefined;
        if (status >= 200 && status < 500) {
          persistence = pool.query(
            `UPDATE payment_idempotency
                SET lifecycle = 'completed', response_status = $1,
                    response_body = $2::jsonb, completed_at = clock_timestamp(),
                    updated_at = clock_timestamp()
              WHERE actor_id = $3 AND route = $4 AND client_key = $5
                AND request_hash = $6`,
            [
              status,
              JSON.stringify(body),
              actorId,
              routeName,
              key,
              requestHash,
            ],
          );
        } else if (status >= 500) {
          persistence = pool.query(
            `UPDATE payment_idempotency
                SET lifecycle = 'failed', locked_until = clock_timestamp(),
                    updated_at = clock_timestamp()
              WHERE actor_id = $1 AND route = $2 AND client_key = $3
                AND request_hash = $4
                AND posting_id IS NULL`,
            [actorId, routeName, key, requestHash],
          );
        }
        if (persistence) {
          // Fail closed: never expose success before the replay record is durable.
          void persistence.then(
            () => originalJson(body),
            async () => {
              try {
                await pool.query(
                  `UPDATE payment_idempotency
                      SET lifecycle = 'failed', locked_until = clock_timestamp(),
                          updated_at = clock_timestamp()
                    WHERE actor_id = $1 AND route = $2 AND client_key = $3
                      AND request_hash = $4 AND posting_id IS NULL`,
                  [actorId, routeName, key, requestHash],
                );
              } catch {
                /* best-effort */
              }
              res.statusCode = 503;
              return originalJson({
                error:
                  'Request may have succeeded but the idempotency record could not be saved. Retry with the same Idempotency-Key.',
                code: 'IDEMPOTENCY_PERSIST_FAILED',
              });
            },
          );
          return res;
        }
      }
      return originalJson(body);
    };
    return paymentContext.run(
      { actorId, route: routeName, key, requestHash },
      next,
    );
  };
}
