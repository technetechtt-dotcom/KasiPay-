import { Router } from 'express';

import {
  opsLoginHandler,
  opsMeHandler,
  requireOpsAuth,
  requireOpsSuperAdmin,
} from '../opsAuth.js';
import { getPgPool } from '../dbPg.js';
import { isPostgresMode } from '../dbRuntime.js';
import { getDb } from '../db.js';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';

export const opsAuthRouterPg = Router();

opsAuthRouterPg.post('/ops/login', opsLoginHandler);
opsAuthRouterPg.get('/ops/me', requireOpsAuth, opsMeHandler);

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

opsAuthRouterPg.get(
  '/ops/admin-users',
  requireOpsAuth,
  requireOpsSuperAdmin,
  async (_req, res) => {
    if (isPostgresMode()) {
      const q = await getPgPool().query<OpsUserRow>(
        `SELECT * FROM ops_admin_users ORDER BY created_at DESC`,
      );
      return res.json({ users: q.rows.map(normalizeOpsUser) });
    }
    const rows = getDb()
      .prepare(`SELECT * FROM ops_admin_users ORDER BY datetime(created_at) DESC`)
      .all() as OpsUserRow[];
    return res.json({ users: rows.map(normalizeOpsUser) });
  },
);

const createBody = z.object({
  username: z.string().trim().min(3).max(60),
  password: z.string().min(8).max(120),
  role: z.enum(['super_admin', 'operator']).default('operator'),
});

opsAuthRouterPg.post(
  '/ops/admin-users',
  requireOpsAuth,
  requireOpsSuperAdmin,
  async (req, res) => {
    const parsed = createBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const now = new Date().toISOString();
    const username = parsed.data.username.toLowerCase();
    const hash = await bcrypt.hash(parsed.data.password, 12);
    const id = randomUUID();
    try {
      if (isPostgresMode()) {
        await getPgPool().query(
          `INSERT INTO ops_admin_users
            (id, username, password_hash, role, is_active, created_at, updated_at)
           VALUES ($1, $2, $3, $4, TRUE, $5, $5)`,
          [id, username, hash, parsed.data.role, now],
        );
        const q = await getPgPool().query<OpsUserRow>(
          `SELECT * FROM ops_admin_users WHERE id = $1`,
          [id],
        );
        return res.status(201).json({ user: normalizeOpsUser(q.rows[0]) });
      }
      getDb()
        .prepare(
          `INSERT INTO ops_admin_users
            (id, username, password_hash, role, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(id, username, hash, parsed.data.role, now, now);
      const row = getDb()
        .prepare(`SELECT * FROM ops_admin_users WHERE id = ?`)
        .get(id) as OpsUserRow;
      return res.status(201).json({ user: normalizeOpsUser(row) });
    } catch {
      return res.status(409).json({ error: 'Username already exists' });
    }
  },
);

const updateBody = z.object({
  role: z.enum(['super_admin', 'operator']).optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(8).max(120).optional(),
});

opsAuthRouterPg.patch(
  '/ops/admin-users/:id',
  requireOpsAuth,
  requireOpsSuperAdmin,
  async (req, res) => {
    const parsed = updateBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const targetId = req.params.id;
    const now = new Date().toISOString();
    if (isPostgresMode()) {
      const existingQ = await getPgPool().query<OpsUserRow>(
        `SELECT * FROM ops_admin_users WHERE id = $1`,
        [targetId],
      );
      const existing = existingQ.rows[0];
      if (!existing) return res.status(404).json({ error: 'Ops user not found' });
      const nextRole = parsed.data.role ?? existing.role;
      const nextActive = parsed.data.isActive ?? Boolean(existing.is_active);
      const nextHash = parsed.data.password
        ? await bcrypt.hash(parsed.data.password, 12)
        : existing.password_hash;
      await getPgPool().query(
        `UPDATE ops_admin_users
            SET role = $1, is_active = $2, password_hash = $3, updated_at = $4
          WHERE id = $5`,
        [nextRole, nextActive, nextHash, now, targetId],
      );
      const q = await getPgPool().query<OpsUserRow>(
        `SELECT * FROM ops_admin_users WHERE id = $1`,
        [targetId],
      );
      return res.json({ user: normalizeOpsUser(q.rows[0]) });
    }
    const existing = getDb()
      .prepare(`SELECT * FROM ops_admin_users WHERE id = ?`)
      .get(targetId) as OpsUserRow | undefined;
    if (!existing) return res.status(404).json({ error: 'Ops user not found' });
    const nextRole = parsed.data.role ?? existing.role;
    const nextActive = parsed.data.isActive ?? Boolean(existing.is_active);
    const nextHash = parsed.data.password
      ? await bcrypt.hash(parsed.data.password, 12)
      : existing.password_hash;
    getDb()
      .prepare(
        `UPDATE ops_admin_users
            SET role = ?, is_active = ?, password_hash = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(nextRole, nextActive ? 1 : 0, nextHash, now, targetId);
    const row = getDb()
      .prepare(`SELECT * FROM ops_admin_users WHERE id = ?`)
      .get(targetId) as OpsUserRow;
    return res.json({ user: normalizeOpsUser(row) });
  },
);

opsAuthRouterPg.delete(
  '/ops/admin-users/:id',
  requireOpsAuth,
  requireOpsSuperAdmin,
  async (req, res) => {
    const targetId = req.params.id;
    if (req.opsAuth?.operatorId === targetId) {
      return res.status(400).json({ error: 'You cannot delete your own account.' });
    }
    if (isPostgresMode()) {
      const r = await getPgPool().query(
        `DELETE FROM ops_admin_users WHERE id = $1`,
        [targetId],
      );
      if ((r.rowCount ?? 0) === 0) {
        return res.status(404).json({ error: 'Ops user not found' });
      }
      return res.json({ ok: true });
    }
    const r = getDb()
      .prepare(`DELETE FROM ops_admin_users WHERE id = ?`)
      .run(targetId);
    if (r.changes === 0) {
      return res.status(404).json({ error: 'Ops user not found' });
    }
    return res.json({ ok: true });
  },
);
