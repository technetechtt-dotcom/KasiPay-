import { randomUUID } from 'node:crypto';

import { Router } from 'express';

import { getPgPool } from '../dbPg.js';
import { toPublicUser } from '../mappers.js';
import { requireCapability } from '../security/authorization.js';
import { createApprovalRequest, requireRecentStepUp } from '../security/approvalsPg.js';
import { recordAuditEventPg } from '../services/auditPg.js';
import { revokeAllUserSessionsPg } from '../sessionAuthPg.js';
import type { RowUser } from '../types.js';
import { adminUserPatchBodySchema } from '../validation.js';

export const adminUsersRouterPg = Router();

adminUsersRouterPg.get('/admin/users', ...requireCapability('users:read'), async (_req, res) => {
  const pool = getPgPool();
  const r = await pool.query<RowUser>(
    `SELECT * FROM users
     WHERE COALESCE(is_system, 0) = 0
       AND deleted_at IS NULL
     ORDER BY created_at DESC
     LIMIT 500`,
  );
  return res.json({ users: r.rows.map(toPublicUser) });
});

adminUsersRouterPg.patch(
  '/admin/users/:id',
  ...requireCapability('user-roles:request'),
  requireRecentStepUp,
  async (req, res) => {
  const parsed = adminUserPatchBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const targetId = req.params.id;
  const actorId = req.auth?.userId ?? null;
  if (actorId && targetId === actorId) {
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
  const approvalRequestId =
    typeof req.body?.approvalRequestId === 'string'
      ? req.body.approvalRequestId
      : null;

  if (role !== undefined && role !== target.role && !approvalRequestId) {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : '';
    const approvalId = await createApprovalRequest({
      actionType: 'user_role_change',
      resourceType: 'user',
      resourceId: targetId,
      payload: { fromRole: target.role, toRole: role },
      reason,
      evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : [],
      makerOperatorId: req.opsAuth!.operatorId,
    });
    return res.status(202).json({ approvalId, state: 'pending' });
  }
  if (role !== undefined && role !== target.role && approvalRequestId) {
    const approved = await pool.query<{
      state: string;
      action_type: string;
      resource_id: string;
      payload: { toRole?: string };
      maker_operator_id: string;
      checker_operator_id: string | null;
      expires_at: Date;
    }>(
      `SELECT state, action_type, resource_id, payload, maker_operator_id,
              checker_operator_id, expires_at
         FROM approval_requests WHERE id = $1`,
      [approvalRequestId],
    );
    const row = approved.rows[0];
    if (
      !row ||
      row.state !== 'approved' ||
      row.action_type !== 'user_role_change' ||
      row.resource_id !== targetId ||
      row.payload.toRole !== role ||
      !row.checker_operator_id ||
      row.maker_operator_id === row.checker_operator_id ||
      row.expires_at.getTime() <= Date.now()
    ) {
      return res.status(409).json({ error: 'A valid two-person role-change approval is required.' });
    }
  }

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
    if (approvalRequestId) {
      const locked = await client.query(
        `SELECT 1 FROM approval_requests
          WHERE id = $1 AND state = 'approved' AND expires_at > NOW() FOR UPDATE`,
        [approvalRequestId],
      );
      if (!locked.rowCount) {
        throw Object.assign(new Error('Approval was already used or expired.'), { status: 409 });
      }
    }

    if (role !== undefined && role !== target.role) {
      await client.query(`UPDATE users SET role = $1, token_version = token_version + 1 WHERE id = $2`, [
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
      await client.query(`UPDATE users SET suspended_at = $1, token_version = token_version + 1 WHERE id = $2`, [
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

    if (approvalRequestId) {
      await client.query(
        `UPDATE approval_requests SET state = 'executed', executed_at = NOW() WHERE id = $1`,
        [approvalRequestId],
      );
      await client.query(
        `INSERT INTO approval_request_events
          (id, approval_request_id, from_state, to_state, actor_operator_id, reason)
         VALUES ($1,$2,'approved','executed',$3,'Approved user role change executed')`,
        [randomUUID(), approvalRequestId, req.opsAuth!.operatorId],
      );
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
  const actorLabel = req.opsAuth
    ? `ops:${req.opsAuth.username}`
    : actorId ?? 'admin';
  await recordAuditEventPg(pool, {
    type: 'admin.user_update',
    message: `${actorLabel} updated user ${target.phone}: ${parts.join(', ')}`,
    actorUserId: actorId,
  });

  return res.json({ user: toPublicUser(updated) });
  },
);
