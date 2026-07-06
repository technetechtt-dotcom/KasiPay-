import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import {
  REFRESH_ABSOLUTE_TTL_SEC,
  REFRESH_TOKEN_TTL_SEC,
} from './config.js';
import { generateRefreshTokenRaw, hashRefreshToken } from './sessionAuth.js';

const SESSION_CACHE_TTL_MS = 30_000;
const sessionCache = new Map<string, number>();

export function invalidateSessionCachePg(sessionId: string): void {
  sessionCache.delete(sessionId);
}

export async function createAuthSessionPg(
  pool: Pool,
  userId: string,
): Promise<{ sessionId: string; refreshRaw: string }> {
  const sessionId = randomUUID();
  const refreshRaw = generateRefreshTokenRaw();
  const hash = hashRefreshToken(refreshRaw);
  const now = Date.now();
  const expiresAt = new Date(now + REFRESH_TOKEN_TTL_SEC * 1000).toISOString();
  const absExpiresAt = new Date(
    now + REFRESH_ABSOLUTE_TTL_SEC * 1000,
  ).toISOString();

  await pool.query(
    `INSERT INTO auth_sessions (
      id, user_id, refresh_token_hash, expires_at, absolute_expires_at, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [sessionId, userId, hash, expiresAt, absExpiresAt, new Date(now).toISOString()],
  );
  return { sessionId, refreshRaw };
}

export async function revokeSessionPg(pool: Pool, sessionId: string): Promise<void> {
  await pool.query(
    `UPDATE auth_sessions
        SET revoked_at = NOW()
      WHERE id = $1
        AND revoked_at IS NULL`,
    [sessionId],
  );
  invalidateSessionCachePg(sessionId);
}

export async function revokeAllUserSessionsPg(
  pool: Pool,
  userId: string,
): Promise<void> {
  const rows = await pool.query<{ id: string }>(
    `SELECT id FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
  await pool.query(
    `UPDATE auth_sessions
        SET revoked_at = NOW()
      WHERE user_id = $1
        AND revoked_at IS NULL`,
    [userId],
  );
  for (const row of rows.rows) invalidateSessionCachePg(row.id);
}

export async function findSessionByRefreshPg(
  pool: Pool,
  refreshRaw: string,
): Promise<{ id: string; user_id: string } | null> {
  const hash = hashRefreshToken(refreshRaw);
  const r = await pool.query<{ id: string; user_id: string }>(
    `SELECT id, user_id
       FROM auth_sessions
      WHERE refresh_token_hash = $1
        AND revoked_at IS NULL
        AND expires_at > NOW()
        AND absolute_expires_at > NOW()`,
    [hash],
  );
  return r.rows[0] ?? null;
}

export async function maybeHandleRefreshReusePg(
  pool: Pool,
  refreshRaw: string,
): Promise<{ reused: true; userId: string } | { reused: false }> {
  const hash = hashRefreshToken(refreshRaw);
  const r = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM auth_sessions WHERE refresh_token_hash = $1 LIMIT 1`,
    [hash],
  );
  const row = r.rows[0];
  if (!row) return { reused: false };
  await revokeAllUserSessionsPg(pool, row.user_id);
  return { reused: true, userId: row.user_id };
}

export async function rotateRefreshTokenForSessionPg(
  pool: Pool,
  sessionId: string,
): Promise<string> {
  const refreshRaw = generateRefreshTokenRaw();
  const hash = hashRefreshToken(refreshRaw);
  const expiresAt = new Date(
    Date.now() + REFRESH_TOKEN_TTL_SEC * 1000,
  ).toISOString();
  const r = await pool.query(
    `UPDATE auth_sessions
        SET refresh_token_hash = $1, expires_at = $2
      WHERE id = $3
        AND revoked_at IS NULL
        AND absolute_expires_at > NOW()`,
    [hash, expiresAt, sessionId],
  );
  if (r.rowCount === 0) {
    throw new Error('SESSION_ROTATE_FAILED');
  }
  invalidateSessionCachePg(sessionId);
  return refreshRaw;
}

export async function isSessionUsablePg(
  pool: Pool,
  sessionId: string,
): Promise<boolean> {
  const cached = sessionCache.get(sessionId);
  if (cached && cached > Date.now()) return true;
  const r = await pool.query(
    `SELECT 1
       FROM auth_sessions
      WHERE id = $1
        AND revoked_at IS NULL
        AND expires_at > NOW()
        AND absolute_expires_at > NOW()`,
    [sessionId],
  );
  const usable = (r.rowCount ?? 0) > 0;
  if (usable) sessionCache.set(sessionId, Date.now() + SESSION_CACHE_TTL_MS);
  return usable;
}
