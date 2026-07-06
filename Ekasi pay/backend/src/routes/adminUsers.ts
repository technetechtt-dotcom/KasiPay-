import { randomUUID } from 'node:crypto';

import { Router } from 'express';

import { getDb } from '../db.js';
import { toPublicUser } from '../mappers.js';
import { requireAuth, requireRoles } from '../middleware/requireAuth.js';
import { recordAuditEvent } from '../services/audit.js';
import { revokeAllUserSessions } from '../sessionAuth.js';
import type { RowUser } from '../types.js';
import { adminUserPatchBodySchema } from '../validation.js';

export const adminUsersRouter = Router();

adminUsersRouter.get(
  '/admin/users',
  requireAuth,
  requireRoles('admin'),
  (_req, res) => {
    const database = getDb();
    const rows = database
      .prepare(
        `SELECT * FROM users
         WHERE COALESCE(is_system, 0) = 0
           AND deleted_at IS NULL
         ORDER BY created_at DESC LIMIT 500`,
      )
      .all() as RowUser[];
    return res.json({ users: rows.map(toPublicUser) });
  },
);

adminUsersRouter.patch(
  '/admin/users/:id',
  requireAuth,
  requireRoles('admin'),
  (req, res) => {
    const parsed = adminUserPatchBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const targetId = req.params.id;
    const actorId = req.auth!.userId;
    if (targetId === actorId) {
      return res
        .status(400)
        .json({ error: 'You cannot change your own role or suspension status.' });
    }

    const database = getDb();
    const target = database
      .prepare(
        `SELECT * FROM users
         WHERE id = ? AND COALESCE(is_system, 0) = 0 AND deleted_at IS NULL`,
      )
      .get(targetId) as RowUser | undefined;
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { role, suspended } = parsed.data;

    if (role !== undefined && target.role === 'admin' && role !== 'admin') {
      const adminCount = (
        database
          .prepare(
            `SELECT COUNT(*) AS c FROM users
             WHERE role = 'admin' AND deleted_at IS NULL AND suspended_at IS NULL`,
          )
          .get() as { c: number }
      ).c;
      if (adminCount <= 1) {
        return res
          .status(409)
          .json({ error: 'Cannot demote the last active admin account.' });
      }
    }

    if (suspended === true && target.role === 'admin') {
      const adminCount = (
        database
          .prepare(
            `SELECT COUNT(*) AS c FROM users
             WHERE role = 'admin' AND deleted_at IS NULL AND suspended_at IS NULL`,
          )
          .get() as { c: number }
      ).c;
      if (adminCount <= 1) {
        return res
          .status(409)
          .json({ error: 'Cannot suspend the last active admin account.' });
      }
    }

    const now = new Date().toISOString();
    database.transaction(() => {
      if (role !== undefined && role !== target.role) {
        database
          .prepare(`UPDATE users SET role = ? WHERE id = ?`)
          .run(role, targetId);
        if (role === 'merchant') {
          const existingMerchant = database
            .prepare(`SELECT id FROM merchants WHERE user_id = ?`)
            .get(targetId) as { id: string } | undefined;
          if (!existingMerchant) {
            database
              .prepare(
                `INSERT INTO merchants (id, user_id, business_name, location, category)
                 VALUES (?, ?, ?, ?, ?)`,
              )
              .run(
                randomUUID(),
                targetId,
                `${target.name.trim()}'s Shop`,
                'South Africa',
                'Retail',
              );
          }
        }
      }

      if (suspended !== undefined) {
        database
          .prepare(`UPDATE users SET suspended_at = ? WHERE id = ?`)
          .run(suspended ? now : null, targetId);
        database
          .prepare(
            `UPDATE wallets SET status = ? WHERE user_id = ? AND wallet_kind = 'user'`,
          )
          .run(suspended ? 'frozen' : 'active', targetId);
        if (suspended) {
          revokeAllUserSessions(database, targetId);
        }
      }
    })();

    const updated = database
      .prepare(`SELECT * FROM users WHERE id = ?`)
      .get(targetId) as RowUser;

    const parts: string[] = [];
    if (role !== undefined && role !== target.role) {
      parts.push(`role ${target.role} -> ${role}`);
    }
    if (suspended !== undefined) {
      parts.push(suspended ? 'suspended' : 'reactivated');
    }
    recordAuditEvent(database, {
      type: 'admin.user_update',
      message: `Admin updated user ${target.phone}: ${parts.join(', ')}`,
      actorUserId: actorId,
    });

    return res.json({ user: toPublicUser(updated) });
  },
);
