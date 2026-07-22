import type { NextFunction, Request, Response } from 'express';

import { getDb } from '../db.js';
import { getPgPool } from '../dbPg.js';
import { isPostgresMode } from '../dbRuntime.js';
import { verifyToken } from '../jwt.js';
import { isSessionUsable } from '../sessionAuth.js';
import { isSessionUsablePg } from '../sessionAuthPg.js';

export type AuthContext = {
  userId: string;
  phone: string;
  role: string;
  sessionId: string;
};

function assertUserAccountActive(userId: string): { ok: true } | { ok: false; status: number; error: string } {
  const row = getDb()
    .prepare(
      `SELECT deleted_at, suspended_at FROM users WHERE id = ?`,
    )
    .get(userId) as { deleted_at: string | null; suspended_at: string | null } | undefined;
  if (!row || row.deleted_at) {
    return { ok: false, status: 401, error: 'Session ended. Sign in again.' };
  }
  if (row.suspended_at) {
    return { ok: false, status: 403, error: 'Account suspended. Contact support.' };
  }
  return { ok: true };
}

async function assertUserAccountActivePg(
  userId: string,
  tokenVersion?: number,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const pool = getPgPool();
  const r = await pool.query<{
    deleted_at: string | null;
    suspended_at: string | null;
    token_version: number;
  }>(
    `SELECT deleted_at, suspended_at, token_version FROM users WHERE id = $1`,
    [userId],
  );
  const row = r.rows[0];
  if (!row || row.deleted_at) {
    return { ok: false, status: 401, error: 'Session ended. Sign in again.' };
  }
  if (row.suspended_at) {
    return { ok: false, status: 403, error: 'Account suspended. Contact support.' };
  }
  if (tokenVersion === undefined || row.token_version !== tokenVersion) {
    return { ok: false, status: 401, error: 'Session security state changed. Sign in again.' };
  }
  return { ok: true };
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }
  const token = header.slice('Bearer '.length).trim();
  try {
    const payload = verifyToken(token);
    const sessionUsable = isPostgresMode()
      ? await isSessionUsablePg(getPgPool(), payload.sid)
      : isSessionUsable(getDb(), payload.sid);
    if (!sessionUsable) {
      return res
        .status(401)
        .json({ error: 'Session ended or expired. Sign in again.' });
    }
    const account = isPostgresMode()
      ? await assertUserAccountActivePg(payload.sub, payload.tv)
      : assertUserAccountActive(payload.sub);
    if (!account.ok) {
      return res.status(account.status).json({ error: account.error });
    }
    req.auth = {
      userId: payload.sub,
      phone: payload.phone,
      role: payload.role,
      sessionId: payload.sid,
    };
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requireRoles(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!roles.includes(req.auth.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    return next();
  };
}
