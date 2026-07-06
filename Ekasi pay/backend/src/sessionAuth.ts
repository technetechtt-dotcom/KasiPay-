import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import {
  REFRESH_ABSOLUTE_TTL_SEC,
  REFRESH_TOKEN_PEPPER,
  REFRESH_TOKEN_TTL_SEC,
} from './config.js';

export function hashRefreshToken(raw: string): string {
  return createHash('sha256')
    .update(`${REFRESH_TOKEN_PEPPER}:${raw}`)
    .digest('hex');
}

export function generateRefreshTokenRaw(): string {
  return randomBytes(32).toString('base64url');
}

export function createAuthSession(
  database: Database.Database,
  userId: string
): { sessionId: string; refreshRaw: string } {
  const sessionId = randomUUID();
  const refreshRaw = generateRefreshTokenRaw();
  const hash = hashRefreshToken(refreshRaw);
  const now = Date.now();
  const expiresMs = now + REFRESH_TOKEN_TTL_SEC * 1000;
  const absExpiresMs = now + REFRESH_ABSOLUTE_TTL_SEC * 1000;
  database
    .prepare(
      `INSERT INTO auth_sessions (
        id, user_id, refresh_token_hash, expires_at, absolute_expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      sessionId,
      userId,
      hash,
      new Date(expiresMs).toISOString(),
      new Date(absExpiresMs).toISOString(),
      new Date(now).toISOString()
    );
  return { sessionId, refreshRaw };
}

export function revokeSession(
  database: Database.Database,
  sessionId: string
): void {
  const nowIso = new Date().toISOString();
  database
    .prepare(
      `UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`
    )
    .run(nowIso, sessionId);
  invalidateSessionCache(sessionId);
}

/** Revoke every session belonging to the user — used on PIN change / forgot-PIN / delete. */
export function revokeAllUserSessions(
  database: Database.Database,
  userId: string,
): void {
  const nowIso = new Date().toISOString();
  const rows = database
    .prepare(
      `SELECT id FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL`,
    )
    .all(userId) as { id: string }[];
  database
    .prepare(
      `UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`,
    )
    .run(nowIso, userId);
  for (const r of rows) invalidateSessionCache(r.id);
}

/**
 * Look up a session by its (still-valid) current refresh hash. Returns null
 * if the token doesn't match a usable session (could be stale/revoked/expired).
 */
export function findSessionByRefresh(
  database: Database.Database,
  refreshRaw: string
): { id: string; user_id: string } | null {
  const hash = hashRefreshToken(refreshRaw);
  const row = database
    .prepare(
      `SELECT id, user_id FROM auth_sessions
       WHERE refresh_token_hash = ? AND revoked_at IS NULL
         AND datetime(expires_at) > datetime('now')
         AND datetime(absolute_expires_at) > datetime('now')`
    )
    .get(hash) as { id: string; user_id: string } | undefined;
  return row ?? null;
}

/**
 * Reuse detection: if the supplied refresh token matches the current hash for
 * *any* session — including revoked or expired ones — that's a leak signal.
 * In that case we revoke the entire session family for that user.
 */
export function maybeHandleRefreshReuse(
  database: Database.Database,
  refreshRaw: string,
): { reused: true; userId: string } | { reused: false } {
  const hash = hashRefreshToken(refreshRaw);
  const row = database
    .prepare(
      `SELECT user_id FROM auth_sessions WHERE refresh_token_hash = ? LIMIT 1`,
    )
    .get(hash) as { user_id: string } | undefined;
  if (!row) return { reused: false };
  revokeAllUserSessions(database, row.user_id);
  return { reused: true, userId: row.user_id };
}

export function rotateRefreshTokenForSession(
  database: Database.Database,
  sessionId: string
): string {
  const refreshRaw = generateRefreshTokenRaw();
  const hash = hashRefreshToken(refreshRaw);
  const expiresMs = Date.now() + REFRESH_TOKEN_TTL_SEC * 1000;
  // We deliberately do NOT bump absolute_expires_at — the hard cap stays.
  const r = database
    .prepare(
      `UPDATE auth_sessions
         SET refresh_token_hash = ?, expires_at = ?
       WHERE id = ?
         AND revoked_at IS NULL
         AND datetime(absolute_expires_at) > datetime('now')`
    )
    .run(hash, new Date(expiresMs).toISOString(), sessionId);
  if (r.changes === 0) {
    throw new Error('SESSION_ROTATE_FAILED');
  }
  invalidateSessionCache(sessionId);
  return refreshRaw;
}

/**
 * Short-lived in-memory cache to avoid a DB round-trip on every authenticated
 * request. We store a positive (usable) verdict; failures bypass the cache and
 * any session-mutating helpers above call `invalidateSessionCache`.
 */
const SESSION_CACHE_TTL_MS = 30_000;
const sessionCache = new Map<string, number>();

export function invalidateSessionCache(sessionId: string): void {
  sessionCache.delete(sessionId);
}

export function isSessionUsable(
  database: Database.Database,
  sessionId: string
): boolean {
  const cached = sessionCache.get(sessionId);
  if (cached && cached > Date.now()) return true;
  const row = database
    .prepare(
      `SELECT 1 FROM auth_sessions WHERE id = ? AND revoked_at IS NULL
         AND datetime(expires_at) > datetime('now')
         AND datetime(absolute_expires_at) > datetime('now')`
    )
    .get(sessionId) as { 1?: number } | undefined;
  const usable = Boolean(row);
  if (usable) sessionCache.set(sessionId, Date.now() + SESSION_CACHE_TTL_MS);
  return usable;
}
