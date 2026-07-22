import bcrypt from 'bcryptjs';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

import { JWT_SECRET, NODE_ENV } from './config.js';
import { getPgPool } from './dbPg.js';
import { isPostgresMode } from './dbRuntime.js';
import { getDb } from './db.js';
import type { OperatorRole } from './security/authorization.js';
import { createOperatorSession } from './security/operatorSessionsPg.js';
import { decryptSensitive, verifyTotp } from './security/totp.js';

const FALLBACK_OPS_JWT = 'dev-only-ops-dashboard-jwt-secret';

/** Ops JWT secret — falls back to app JWT_SECRET so one backend can run without a second secret. */
export const OPS_JWT_SECRET = (() => {
  const raw = process.env.OPS_JWT_SECRET?.trim();
  if (raw && raw.length >= 32) return raw;
  if (NODE_ENV === 'production') {
    // Prefer dedicated secret; otherwise reuse app JWT secret.
    if (JWT_SECRET.length >= 32) return JWT_SECRET;
    throw new Error(
      'OPS_JWT_SECRET (or JWT_SECRET >= 32 chars) is required for ops login in production.',
    );
  }
  return raw || FALLBACK_OPS_JWT;
})();

export const OPS_TOKEN_TTL_SEC = Math.min(
  Number(process.env.OPS_TOKEN_TTL_SEC ?? 600),
  900,
);

export type OpsAuth = {
  operatorId: string;
  username: string;
  role: OperatorRole;
  sessionId: string;
  tokenVersion: number;
};

type OpsUserRow = {
  id: string;
  username: string;
  password_hash: string;
  role: OperatorRole;
  is_active: boolean | number;
  token_version: number;
  mfa_secret_encrypted: string | null;
  mfa_enabled_at: string | null;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
};

function normalizeOpsUser(row: OpsUserRow) {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  };
}

/** Legacy SQLite table initialization only. PostgreSQL structure is migration-owned. */
export async function ensureOpsAuthStore(): Promise<void> {
  if (isPostgresMode()) {
    return;
  }

  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS ops_admin_users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT
    );
  `);

}

async function findOpsUserByUsername(username: string): Promise<OpsUserRow | null> {
  if (isPostgresMode()) {
    const q = await getPgPool().query<OpsUserRow>(
      `SELECT * FROM ops_admin_users WHERE lower(username) = lower($1)`,
      [username],
    );
    return q.rows[0] ?? null;
  }
  const row = getDb()
    .prepare(`SELECT * FROM ops_admin_users WHERE lower(username) = lower(?)`)
    .get(username) as OpsUserRow | undefined;
  return row ?? null;
}

export function issueOpsToken(user: {
  id: string;
  username: string;
  role: OperatorRole;
  tokenVersion: number;
  sessionId: string;
}): string {
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      role: user.role,
      sid: user.sessionId,
      tv: user.tokenVersion,
      kind: 'ops',
    },
    OPS_JWT_SECRET,
    { expiresIn: OPS_TOKEN_TTL_SEC, issuer: 'ekasi-ops' },
  );
}

const loginBody = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
  totp: z.string().regex(/^\d{6}$/u).optional(),
  device: z.object({
    installId: z.string().min(8).max(200).optional(),
    label: z.string().min(1).max(100).optional(),
    platform: z.string().max(40).optional(),
  }).optional(),
});

export async function opsLoginHandler(req: Request, res: Response) {
  const parsed = loginBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  const user = await findOpsUserByUsername(parsed.data.username);
  if (!user || !user.is_active) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  const ok = await bcrypt.compare(parsed.data.password, user.password_hash);
  if (!ok) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  if (isPostgresMode()) {
    if (!user.mfa_enabled_at || !user.mfa_secret_encrypted) {
      return res.status(403).json({
        error: 'MFA enrollment is required before operator access can be issued.',
        code: 'MFA_ENROLLMENT_REQUIRED',
      });
    }
    if (
      !parsed.data.totp ||
      !verifyTotp(decryptSensitive(user.mfa_secret_encrypted), parsed.data.totp)
    ) {
      return res.status(401).json({ error: 'Invalid username, password, or MFA code.' });
    }
  }
  const now = new Date().toISOString();
  if (isPostgresMode()) {
    await getPgPool().query(
      `UPDATE ops_admin_users SET last_login_at = $1, updated_at = $1 WHERE id = $2`,
      [now, user.id],
    );
  } else {
    getDb()
      .prepare(
        `UPDATE ops_admin_users SET last_login_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(now, now, user.id);
  }
  if (!isPostgresMode()) {
    return res.status(503).json({ error: 'Operator sessions require PostgreSQL.' });
  }
  const session = await createOperatorSession(
    getPgPool(),
    user.id,
    user.token_version,
    parsed.data.device,
  );
  return res.json({
    token: issueOpsToken({
      id: user.id,
      username: user.username,
      role: user.role,
      tokenVersion: user.token_version,
      sessionId: session.id,
    }),
    refreshToken: session.refreshToken,
    expiresInSec: OPS_TOKEN_TTL_SEC,
    user: normalizeOpsUser({ ...user, last_login_at: now }),
  });
}

export async function requireOpsAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }
  const token = header.slice('Bearer '.length).trim();
  try {
    const payload = jwt.verify(token, OPS_JWT_SECRET, {
      issuer: 'ekasi-ops',
    }) as {
      sub?: string;
      username?: string;
      role?: OperatorRole;
      sid?: string;
      tv?: number;
      kind?: string;
    };
    if (!payload.sub || !payload.username || !payload.role || !payload.sid || !payload.tv) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    if (!isPostgresMode()) {
      return res.status(403).json({ error: 'Operator sessions require PostgreSQL.' });
    }
    const live = await getPgPool().query(
      `SELECT 1 FROM operator_sessions s
        JOIN ops_admin_users o ON o.id = s.operator_id
       WHERE s.id = $1 AND s.operator_id = $2 AND s.revoked_at IS NULL
         AND s.expires_at > NOW() AND s.absolute_expires_at > NOW()
         AND s.token_version = $3 AND o.token_version = $3 AND o.is_active = TRUE`,
      [payload.sid, payload.sub, payload.tv],
    );
    if (!live.rowCount) {
      return res.status(401).json({ error: 'Operator session ended or revoked.' });
    }
    req.opsAuth = {
      operatorId: payload.sub,
      username: payload.username,
      role: payload.role,
      sessionId: payload.sid,
      tokenVersion: payload.tv,
    };
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export async function opsMeHandler(req: Request, res: Response) {
  if (!req.opsAuth) return res.status(401).json({ error: 'Unauthorized' });
  if (isPostgresMode()) {
    const q = await getPgPool().query<OpsUserRow>(
      `SELECT * FROM ops_admin_users WHERE id = $1`,
      [req.opsAuth.operatorId],
    );
    const row = q.rows[0];
    if (!row) return res.status(404).json({ error: 'Ops user not found' });
    return res.json({ user: normalizeOpsUser(row) });
  }
  const row = getDb()
    .prepare(`SELECT * FROM ops_admin_users WHERE id = ?`)
    .get(req.opsAuth.operatorId) as OpsUserRow | undefined;
  if (!row) return res.status(404).json({ error: 'Ops user not found' });
  return res.json({ user: normalizeOpsUser(row) });
}

