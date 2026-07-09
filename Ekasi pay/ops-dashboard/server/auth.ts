import { randomUUID } from 'node:crypto';

import bcrypt from 'bcryptjs';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

import { getPgPool, getSqliteDb, isPostgresMode } from './db.js';
import { OPS_JWT_SECRET, OPS_TOKEN_TTL_SEC } from './config.js';

export type OpsAuth = {
  operatorId: string;
  username: string;
  role: 'super_admin' | 'operator';
};

declare global {
  namespace Express {
    interface Request {
      opsAuth?: OpsAuth;
    }
  }
}

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

async function findOpsUserByUsername(username: string): Promise<OpsUserRow | null> {
  if (isPostgresMode()) {
    const pool = getPgPool();
    const q = await pool.query<OpsUserRow>(
      `SELECT * FROM ops_admin_users WHERE lower(username) = lower($1)`,
      [username],
    );
    return q.rows[0] ?? null;
  }
  const db = getSqliteDb();
  const row = db
    .prepare(`SELECT * FROM ops_admin_users WHERE lower(username) = lower(?)`)
    .get(username) as OpsUserRow | undefined;
  return row ?? null;
}

async function updateLastLogin(userId: string): Promise<void> {
  const now = new Date().toISOString();
  if (isPostgresMode()) {
    const pool = getPgPool();
    await pool.query(
      `UPDATE ops_admin_users SET last_login_at = $1, updated_at = $1 WHERE id = $2`,
      [now, userId],
    );
    return;
  }
  const db = getSqliteDb();
  db.prepare(`UPDATE ops_admin_users SET last_login_at = ?, updated_at = ? WHERE id = ?`).run(
    now,
    now,
    userId,
  );
}

export function issueOpsToken(user: {
  id: string;
  username: string;
  role: 'super_admin' | 'operator';
}): string {
  return jwt.sign({ sub: user.id, username: user.username, role: user.role }, OPS_JWT_SECRET, {
    expiresIn: OPS_TOKEN_TTL_SEC,
  });
}

const loginBody = z.object({
  username: z.string().trim().min(1).default('superadmin'),
  password: z.string().min(1),
});

export async function loginHandler(req: Request, res: Response) {
  const parsed = loginBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'username and password are required' });
  }
  const { username } = parsed.data;
  const password =
    typeof req.body?.password === 'string' ? req.body.password : '';
  const user = await findOpsUserByUsername(username);
  if (!user || !Boolean(user.is_active)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  await updateLastLogin(user.id);
  const token = issueOpsToken({ id: user.id, username: user.username, role: user.role });
  return res.json({
    token,
    expiresInSec: OPS_TOKEN_TTL_SEC,
    user: normalizeOpsUser(user),
  });
}

export function requireOpsAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }
  const token = header.slice('Bearer '.length).trim();
  try {
    const payload = jwt.verify(token, OPS_JWT_SECRET) as {
      sub?: string;
      username?: string;
      role?: 'super_admin' | 'operator';
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

export function requireOpsSuperAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.opsAuth || req.opsAuth.role !== 'super_admin') {
    return res.status(403).json({ error: 'Super admin access required' });
  }
  return next();
}

export async function opsMeHandler(req: Request, res: Response) {
  if (!req.opsAuth) return res.status(401).json({ error: 'Unauthorized' });
  if (isPostgresMode()) {
    const pool = getPgPool();
    const q = await pool.query<OpsUserRow>(
      `SELECT * FROM ops_admin_users WHERE id = $1`,
      [req.opsAuth.operatorId],
    );
    const row = q.rows[0];
    if (!row) return res.status(404).json({ error: 'Ops user not found' });
    return res.json({ user: normalizeOpsUser(row) });
  }
  const db = getSqliteDb();
  const row = db
    .prepare(`SELECT * FROM ops_admin_users WHERE id = ?`)
    .get(req.opsAuth.operatorId) as OpsUserRow | undefined;
  if (!row) return res.status(404).json({ error: 'Ops user not found' });
  return res.json({ user: normalizeOpsUser(row) });
}

export async function listOpsUsersHandler(_req: Request, res: Response) {
  if (isPostgresMode()) {
    const pool = getPgPool();
    const q = await pool.query<OpsUserRow>(
      `SELECT * FROM ops_admin_users ORDER BY created_at DESC`,
    );
    return res.json({ users: q.rows.map(normalizeOpsUser) });
  }
  const db = getSqliteDb();
  const rows = db
    .prepare(`SELECT * FROM ops_admin_users ORDER BY datetime(created_at) DESC`)
    .all() as OpsUserRow[];
  return res.json({ users: rows.map(normalizeOpsUser) });
}

const createOpsUserBody = z.object({
  username: z.string().trim().min(3).max(60),
  password: z.string().min(8).max(120),
  role: z.enum(['super_admin', 'operator']).default('operator'),
});

export async function createOpsUserHandler(req: Request, res: Response) {
  const parsed = createOpsUserBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const now = new Date().toISOString();
  const username = parsed.data.username.toLowerCase();
  const hash = await bcrypt.hash(parsed.data.password, 12);
  if (isPostgresMode()) {
    const pool = getPgPool();
    try {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO ops_admin_users
          (id, username, password_hash, role, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, TRUE, $5, $5)`,
        [id, username, hash, parsed.data.role, now],
      );
      const q = await pool.query<OpsUserRow>(`SELECT * FROM ops_admin_users WHERE id = $1`, [id]);
      return res.status(201).json({ user: normalizeOpsUser(q.rows[0]) });
    } catch {
      return res.status(409).json({ error: 'Username already exists' });
    }
  }
  const db = getSqliteDb();
  try {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO ops_admin_users
        (id, username, password_hash, role, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    ).run(id, username, hash, parsed.data.role, now, now);
    const row = db.prepare(`SELECT * FROM ops_admin_users WHERE id = ?`).get(id) as OpsUserRow;
    return res.status(201).json({ user: normalizeOpsUser(row) });
  } catch {
    return res.status(409).json({ error: 'Username already exists' });
  }
}

const updateOpsUserBody = z.object({
  role: z.enum(['super_admin', 'operator']).optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(8).max(120).optional(),
});

export async function updateOpsUserHandler(req: Request, res: Response) {
  const parsed = updateOpsUserBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const targetId = req.params.id;
  const now = new Date().toISOString();
  const updates = parsed.data;

  if (isPostgresMode()) {
    const pool = getPgPool();
    const existingQ = await pool.query<OpsUserRow>(`SELECT * FROM ops_admin_users WHERE id = $1`, [targetId]);
    const existing = existingQ.rows[0];
    if (!existing) return res.status(404).json({ error: 'Ops user not found' });
    const nextRole = updates.role ?? existing.role;
    const nextActive = updates.isActive ?? Boolean(existing.is_active);
    const nextHash = updates.password ? await bcrypt.hash(updates.password, 12) : existing.password_hash;
    await pool.query(
      `UPDATE ops_admin_users
          SET role = $1, is_active = $2, password_hash = $3, updated_at = $4
        WHERE id = $5`,
      [nextRole, nextActive, nextHash, now, targetId],
    );
    const q = await pool.query<OpsUserRow>(`SELECT * FROM ops_admin_users WHERE id = $1`, [targetId]);
    return res.json({ user: normalizeOpsUser(q.rows[0]) });
  }

  const db = getSqliteDb();
  const existing = db
    .prepare(`SELECT * FROM ops_admin_users WHERE id = ?`)
    .get(targetId) as OpsUserRow | undefined;
  if (!existing) return res.status(404).json({ error: 'Ops user not found' });
  const nextRole = updates.role ?? existing.role;
  const nextActive = updates.isActive ?? Boolean(existing.is_active);
  const nextHash = updates.password ? await bcrypt.hash(updates.password, 12) : existing.password_hash;
  db.prepare(
    `UPDATE ops_admin_users
        SET role = ?, is_active = ?, password_hash = ?, updated_at = ?
      WHERE id = ?`,
  ).run(nextRole, nextActive ? 1 : 0, nextHash, now, targetId);
  const row = db.prepare(`SELECT * FROM ops_admin_users WHERE id = ?`).get(targetId) as OpsUserRow;
  return res.json({ user: normalizeOpsUser(row) });
}

export async function deleteOpsUserHandler(req: Request, res: Response) {
  const targetId = req.params.id;
  if (req.opsAuth?.operatorId === targetId) {
    return res.status(400).json({ error: 'You cannot delete your own account.' });
  }
  if (isPostgresMode()) {
    const pool = getPgPool();
    const r = await pool.query(`DELETE FROM ops_admin_users WHERE id = $1`, [targetId]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Ops user not found' });
    return res.json({ ok: true });
  }
  const db = getSqliteDb();
  const r = db.prepare(`DELETE FROM ops_admin_users WHERE id = ?`).run(targetId);
  if (r.changes === 0) return res.status(404).json({ error: 'Ops user not found' });
  return res.json({ ok: true });
}
