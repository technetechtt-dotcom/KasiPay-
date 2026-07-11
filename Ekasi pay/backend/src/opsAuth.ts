import { randomUUID } from 'node:crypto';

import bcrypt from 'bcryptjs';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

import { JWT_SECRET, NODE_ENV } from './config.js';
import { getPgPool } from './dbPg.js';
import { isPostgresMode } from './dbRuntime.js';
import { getDb } from './db.js';
import { requireAuth, requireRoles } from './middleware/requireAuth.js';

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

export const OPS_TOKEN_TTL_SEC = Number(
  process.env.OPS_TOKEN_TTL_SEC ?? 8 * 60 * 60,
);

export const OPS_SUPER_ADMIN_USERNAME =
  process.env.OPS_SUPER_ADMIN_USERNAME?.trim() || 'IvanIJ';
/** Password for the single env-managed ops account (`OPS_SUPER_ADMIN_USERNAME`). */
export const OPS_SUPER_ADMIN_PASSWORD =
  process.env.OPS_DASHBOARD_PASSWORD?.trim() ||
  process.env.OPS_SUPER_ADMIN_PASSWORD?.trim() ||
  '';

export type OpsAuth = {
  operatorId: string;
  username: string;
  role: 'super_admin' | 'operator';
};

type OpsUserRow = {
  id: string;
  username: string;
  password_hash: string;
  role: 'super_admin' | 'operator';
  is_active: boolean | number;
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

function looksLikeBcrypt(value: string): boolean {
  return /^\$2[aby]\$\d{2}\$/.test(value);
}

async function hashOpsPassword(raw: string): Promise<string> {
  return looksLikeBcrypt(raw) ? raw : bcrypt.hash(raw, 12);
}

/**
 * One env-managed ops account:
 *   username = OPS_SUPER_ADMIN_USERNAME
 *   password = OPS_DASHBOARD_PASSWORD (or OPS_SUPER_ADMIN_PASSWORD)
 * Creates the user if missing; updates password/role/active when password env is set.
 */
export async function ensureOpsAuthStore(): Promise<void> {
  const username = OPS_SUPER_ADMIN_USERNAME.toLowerCase();
  const password = OPS_SUPER_ADMIN_PASSWORD;

  if (isPostgresMode()) {
    const pool = getPgPool();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ops_admin_users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        last_login_at TIMESTAMPTZ
      );
    `);

    if (!password) {
      console.warn(
        '[ops-auth] OPS_DASHBOARD_PASSWORD not set — env superadmin account will not be synced.',
      );
      return;
    }

    const now = new Date().toISOString();
    const hash = await hashOpsPassword(password);
    const existing = await pool.query<{ id: string }>(
      `SELECT id FROM ops_admin_users WHERE lower(username) = lower($1)`,
      [username],
    );
    if (existing.rows[0]) {
      await pool.query(
        `UPDATE ops_admin_users
            SET password_hash = $1,
                role = 'super_admin',
                is_active = TRUE,
                updated_at = $2
          WHERE id = $3`,
        [hash, now, existing.rows[0].id],
      );
      console.info(`[ops-auth] Synced env superadmin "${username}"`);
    } else {
      await pool.query(
        `INSERT INTO ops_admin_users
          (id, username, password_hash, role, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, 'super_admin', TRUE, $4, $4)`,
        [randomUUID(), username, hash, now],
      );
      console.info(`[ops-auth] Created env superadmin "${username}"`);
    }
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

  if (!password) {
    console.warn(
      '[ops-auth] OPS_DASHBOARD_PASSWORD not set — env superadmin account will not be synced.',
    );
    return;
  }

  const now = new Date().toISOString();
  const hash = looksLikeBcrypt(password)
    ? password
    : bcrypt.hashSync(password, 12);
  const existing = db
    .prepare(`SELECT id FROM ops_admin_users WHERE lower(username) = lower(?)`)
    .get(username) as { id: string } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE ops_admin_users
          SET password_hash = ?, role = 'super_admin', is_active = 1, updated_at = ?
        WHERE id = ?`,
    ).run(hash, now, existing.id);
    console.info(`[ops-auth] Synced env superadmin "${username}"`);
  } else {
    db.prepare(
      `INSERT INTO ops_admin_users
        (id, username, password_hash, role, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 'super_admin', 1, ?, ?)`,
    ).run(randomUUID(), username, hash, now, now);
    console.info(`[ops-auth] Created env superadmin "${username}"`);
  }
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

function issueOpsToken(user: {
  id: string;
  username: string;
  role: 'super_admin' | 'operator';
}): string {
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      role: user.role,
      kind: 'ops',
    },
    OPS_JWT_SECRET,
    { expiresIn: OPS_TOKEN_TTL_SEC, issuer: 'ekasi-ops' },
  );
}

const loginBody = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
});

export async function opsLoginHandler(req: Request, res: Response) {
  const parsed = loginBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  const user = await findOpsUserByUsername(parsed.data.username);
  if (!user || !Boolean(user.is_active)) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  const ok = await bcrypt.compare(parsed.data.password, user.password_hash);
  if (!ok) {
    return res.status(401).json({ error: 'Invalid username or password.' });
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
  return res.json({
    token: issueOpsToken({
      id: user.id,
      username: user.username,
      role: user.role,
    }),
    expiresInSec: OPS_TOKEN_TTL_SEC,
    user: normalizeOpsUser({ ...user, last_login_at: now }),
  });
}

export function requireOpsAuth(req: Request, res: Response, next: NextFunction) {
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
      role?: 'super_admin' | 'operator';
      kind?: string;
    };
    if (!payload.sub || !payload.username || !payload.role) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    req.opsAuth = {
      operatorId: payload.sub,
      username: payload.username,
      role: payload.role,
    };
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/** Allow either app admin JWT or ops username/password JWT. */
export function requireAdminOrOps(
  req: Request,
  res: Response,
  next: NextFunction,
) {
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
      role?: 'super_admin' | 'operator';
    };
    if (payload.sub && payload.username && payload.role) {
      req.opsAuth = {
        operatorId: payload.sub,
        username: payload.username,
        role: payload.role,
      };
      return next();
    }
  } catch {
    /* fall through to app admin auth */
  }

  return requireAuth(req, res, (err?: unknown) => {
    if (err) return next(err as Error);
    return requireRoles('admin')(req, res, next);
  });
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

export function requireOpsSuperAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (!req.opsAuth || req.opsAuth.role !== 'super_admin') {
    return res.status(403).json({ error: 'Super admin access required' });
  }
  return next();
}
