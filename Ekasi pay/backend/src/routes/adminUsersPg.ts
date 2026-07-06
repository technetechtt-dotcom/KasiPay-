import { randomUUID } from 'node:crypto';

import { Router } from 'express';

import { getPgPool } from '../dbPg.js';
import { toPublicUser } from '../mappers.js';
import { requireAuth, requireRoles } from '../middleware/requireAuth.js';
import { recordAuditEventPg } from '../services/auditPg.js';
import { revokeAllUserSessionsPg } from '../sessionAuthPg.js';
import type { RowUser } from '../types.js';
import { adminUserPatchBodySchema } from '../validation.js';

export const adminUsersRouterPg = Router();

adminUsersRouterPg.get(
  '/admin/users',
  requireAuth,
  requireRoles('admin'),
  async (_req, res) => {
    const pool = getPgPool();
    const r = await pool.query<RowUser>(
      `SELECT * FROM users
       WHERE COALESCE(is_system, 0) = 0
         AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT 500`,
    );
    return res.json({ users: r.rows.map(toPublicUser) });
  },
);

adminUsersRouterPg.patch(
  '/admin/users/:id',
  requireAuth,
  requireRoles('admin'),
  async (req, res) => {
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

    const pool = getPgPool();
    const targetQ = await pool.query<RowUser>(
      `SELECT * FROM users
       WHERE id = $1 AND COALESCE(is_system, 0) = 0 AND deleted_at IS NULL`,
      [targetId],
    );
    const target = targetQ.rows[0];
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { role, suspended } = parsed.data;

    if (role !== undefined && target.role === 'admin' && role !== 'admin') {
      const adminCountQ = await pool.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM users
         WHERE role = 'admin' AND deleted_at IS NULL AND suspended_at IS NULL`,
      );
      if (Number(adminCountQ.rows[0]?.c ?? 0) <= 1) {
        return res
          .status(409)
          .json({ error: 'Cannot demote the last active admin account.' });
      }
    }

    if (suspended === true && target.role === 'admin') {
      const adminCountQ = await pool.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM users
         WHERE role = 'admin' AND deleted_at IS NULL AND suspended_at IS NULL`,
      );
      if (Number(adminCountQ.rows[0]?.c ?? 0) <= 1) {
        return res
          .status(409)
          .json({ error: 'Cannot suspend the last active admin account.' });
      }
    }

    const now = new Date().toISOString();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (role !== undefined && role !== target.role) {
        await client.query(`UPDATE users SET role = $1 WHERE id = $2`, [
          role,
          targetId,
        ]);
        if (role === 'merchant') {
          const existingMerchant = await client.query<{ id: string }>(
            `SELECT id FROM merchants WHERE user_id = $1`,
            [targetId],
          );
          if (!existingMerchant.rows[0]) {
            await client.query(
              `INSERT INTO merchants (id, user_id, business_name, location, category)
               VALUES ($1, $2, $3, $4, $5)`,
              [
                randomUUID(),
                targetId,
                `${target.name.trim()}'s Shop`,
                'South Africa',
                'Retail',
              ],
            );
          }
        }
      }

      if (suspended !== undefined) {
        await client.query(`UPDATE users SET suspended_at = $1 WHERE id = $2`, [
          suspended ? now : null,
          targetId,
        ]);
        await client.query(
          `UPDATE wallets SET status = $1 WHERE user_id = $2 AND wallet_kind = 'user'`,
          [suspended ? 'frozen' : 'active', targetId],
        );
        if (suspended) {
          await revokeAllUserSessionsPg(pool, targetId);
        }
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    const updatedQ = await pool.query<RowUser>(
      `SELECT * FROM users WHERE id = $1`,
      [targetId],
    );
    const updated = updatedQ.rows[0];

    const parts: string[] = [];
    if (role !== undefined && role !== target.role) {
      parts.push(`role ${target.role} -> ${role}`);
    }
    if (suspended !== undefined) {
      parts.push(suspended ? 'suspended' : 'reactivated');
    }
    await recordAuditEventPg(pool, {
      type: 'admin.user_update',
      message: `Admin updated user ${target.phone}: ${parts.join(', ')}`,
      actorUserId: actorId,
    });

    return res.json({ user: toPublicUser(updated) });
  },
);
