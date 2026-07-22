import { Router } from 'express';

import {
  issueOpsToken,
  opsLoginHandler,
  opsMeHandler,
  requireOpsAuth,
} from '../opsAuth.js';
import { getPgPool } from '../dbPg.js';
import { isPostgresMode } from '../dbRuntime.js';
import { getDb } from '../db.js';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { requireCapability, OPERATOR_ROLES, type OperatorRole } from '../security/authorization.js';
import {
  revokeOperatorSessions,
  rotateOperatorRefresh,
} from '../security/operatorSessionsPg.js';
import {
  decryptSensitive,
  encryptSensitive,
  generateTotpSecret,
  verifyTotp,
} from '../security/totp.js';

export const opsAuthRouterPg = Router();

opsAuthRouterPg.post('/ops/login', opsLoginHandler);
opsAuthRouterPg.get('/ops/me', requireOpsAuth, opsMeHandler);

opsAuthRouterPg.post('/ops/refresh', async (req, res) => {
  const parsed = z.object({ refreshToken: z.string().min(40) }).safeParse(req.body);
  if (!parsed.success || !isPostgresMode()) {
    return res.status(401).json({ error: 'Invalid refresh session.' });
  }
  const rotated = await rotateOperatorRefresh(getPgPool(), parsed.data.refreshToken);
  if (!rotated) return res.status(401).json({ error: 'Invalid refresh session.' });
  const operator = await getPgPool().query<OpsUserRow>(
    `SELECT * FROM ops_admin_users WHERE id = $1 AND is_active = TRUE`,
    [rotated.operator_id],
  );
  const row = operator.rows[0];
  if (!row || row.token_version !== rotated.token_version) {
    await revokeOperatorSessions(getPgPool(), rotated.operator_id, 'operator_changed');
    return res.status(401).json({ error: 'Operator session revoked.' });
  }
  return res.json({
    token: issueOpsToken({
      id: row.id,
      username: row.username,
      role: row.role,
      tokenVersion: row.token_version,
      sessionId: rotated.id,
    }),
    refreshToken: rotated.refreshToken,
  });
});

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

opsAuthRouterPg.get(
  '/ops/admin-users',
  ...requireCapability('operators:read'),
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
  role: z.enum(OPERATOR_ROLES).default('support'),
});

opsAuthRouterPg.post(
  '/ops/admin-users',
  ...requireCapability('operators:write'),
  async (req, res) => {
    const parsed = createBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const now = new Date().toISOString();
    const username = parsed.data.username.toLowerCase();
    const hash = await bcrypt.hash(parsed.data.password, 12);
    const id = randomUUID();
    const mfaSecret = generateTotpSecret();
    try {
      if (isPostgresMode()) {
        await getPgPool().query(
          `INSERT INTO ops_admin_users
            (id, username, password_hash, role, is_active, created_at, updated_at,
             mfa_secret_encrypted, mfa_enabled_at)
           VALUES ($1, $2, $3, $4, TRUE, $5, $5, $6, $5)`,
          [id, username, hash, parsed.data.role, now, encryptSensitive(mfaSecret)],
        );
        const q = await getPgPool().query<OpsUserRow>(
          `SELECT * FROM ops_admin_users WHERE id = $1`,
          [id],
        );
        return res.status(201).json({
          user: normalizeOpsUser(q.rows[0]),
          mfaEnrollment: {
            secret: mfaSecret,
            otpauthUrl: `otpauth://totp/EkasiPay:${encodeURIComponent(username)}?secret=${mfaSecret}&issuer=EkasiPay`,
          },
        });
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
  role: z.enum(OPERATOR_ROLES).optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(8).max(120).optional(),
});

opsAuthRouterPg.patch(
  '/ops/admin-users/:id',
  ...requireCapability('operators:write'),
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
      const securityChanged =
        nextRole !== existing.role ||
        nextActive !== Boolean(existing.is_active) ||
        Boolean(parsed.data.password);
      await getPgPool().query(
        `UPDATE ops_admin_users
            SET role = $1, is_active = $2, password_hash = $3, updated_at = $4,
                token_version = token_version + CASE WHEN $6 THEN 1 ELSE 0 END,
                password_changed_at = CASE WHEN $7 THEN $4 ELSE password_changed_at END
          WHERE id = $5`,
        [nextRole, nextActive, nextHash, now, targetId, securityChanged, Boolean(parsed.data.password)],
      );
      if (securityChanged) {
        await revokeOperatorSessions(getPgPool(), targetId, 'operator_security_changed');
      }
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
  ...requireCapability('operators:write'),
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

opsAuthRouterPg.post('/ops/mfa/enroll', requireOpsAuth, async (req, res) => {
  if (!req.opsAuth || !isPostgresMode()) return res.status(403).json({ error: 'Unavailable' });
  const secret = generateTotpSecret();
  await getPgPool().query(
    `UPDATE ops_admin_users SET mfa_secret_encrypted = $1, mfa_enabled_at = NULL
      WHERE id = $2`,
    [encryptSensitive(secret), req.opsAuth.operatorId],
  );
  return res.json({
    secret,
    otpauthUrl: `otpauth://totp/EkasiPay:${encodeURIComponent(req.opsAuth.username)}?secret=${secret}&issuer=EkasiPay`,
  });
});

opsAuthRouterPg.post('/ops/mfa/confirm', requireOpsAuth, async (req, res) => {
  const parsed = z.object({ code: z.string().regex(/^\d{6}$/u) }).safeParse(req.body);
  if (!parsed.success || !req.opsAuth || !isPostgresMode()) {
    return res.status(400).json({ error: 'Valid MFA code required.' });
  }
  const found = await getPgPool().query<{ mfa_secret_encrypted: string | null }>(
    `SELECT mfa_secret_encrypted FROM ops_admin_users WHERE id = $1`,
    [req.opsAuth.operatorId],
  );
  const encrypted = found.rows[0]?.mfa_secret_encrypted;
  if (!encrypted || !verifyTotp(decryptSensitive(encrypted), parsed.data.code)) {
    return res.status(401).json({ error: 'Invalid MFA code.' });
  }
  await getPgPool().query(
    `UPDATE ops_admin_users SET mfa_enabled_at = NOW(), token_version = token_version + 1
      WHERE id = $1`,
    [req.opsAuth.operatorId],
  );
  await revokeOperatorSessions(getPgPool(), req.opsAuth.operatorId, 'mfa_enrolled');
  return res.json({ ok: true });
});

opsAuthRouterPg.post('/ops/step-up', requireOpsAuth, async (req, res) => {
  const parsed = z.object({ method: z.enum(['totp', 'passkey']).default('totp'), code: z.string().optional() }).safeParse(req.body);
  if (!parsed.success || !req.opsAuth || !isPostgresMode()) {
    return res.status(400).json({ error: 'Valid step-up request required.' });
  }
  if (parsed.data.method === 'passkey') {
    return res.status(501).json({ error: 'Passkey verification provider is not configured.' });
  }
  const found = await getPgPool().query<{ mfa_secret_encrypted: string | null }>(
    `SELECT mfa_secret_encrypted FROM ops_admin_users WHERE id = $1 AND is_active = TRUE`,
    [req.opsAuth.operatorId],
  );
  const encrypted = found.rows[0]?.mfa_secret_encrypted;
  if (!encrypted || !parsed.data.code || !verifyTotp(decryptSensitive(encrypted), parsed.data.code)) {
    return res.status(401).json({ error: 'Step-up authentication failed.' });
  }
  await getPgPool().query(
    `INSERT INTO operator_step_up
      (id, operator_id, session_id, method, expires_at)
     VALUES ($1,$2,$3,'totp',NOW() + interval '5 minutes')`,
    [randomUUID(), req.opsAuth.operatorId, req.opsAuth.sessionId],
  );
  return res.json({ ok: true, expiresInSec: 300 });
});

opsAuthRouterPg.get('/ops/sessions', requireOpsAuth, async (req, res) => {
  const sessions = await getPgPool().query(
    `SELECT s.id, s.created_at, s.last_seen_at, s.expires_at, s.revoked_at,
            d.label AS device_label, d.platform
       FROM operator_sessions s LEFT JOIN operator_devices d ON d.id = s.device_id
      WHERE s.operator_id = $1 ORDER BY s.last_seen_at DESC`,
    [req.opsAuth!.operatorId],
  );
  return res.json({ sessions: sessions.rows });
});

opsAuthRouterPg.delete('/ops/sessions/:id', requireOpsAuth, async (req, res) => {
  const result = await getPgPool().query(
    `UPDATE operator_sessions SET revoked_at = NOW(), revoke_reason = 'operator_revoked'
      WHERE id = $1 AND operator_id = $2 AND revoked_at IS NULL`,
    [req.params.id, req.opsAuth!.operatorId],
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Session not found.' });
  return res.json({ ok: true });
});

opsAuthRouterPg.get('/ops/devices', requireOpsAuth, async (req, res) => {
  const devices = await getPgPool().query(
    `SELECT id, label, platform, first_seen_at, last_seen_at, trusted_at, revoked_at
       FROM operator_devices WHERE operator_id = $1 ORDER BY last_seen_at DESC`,
    [req.opsAuth!.operatorId],
  );
  return res.json({ devices: devices.rows });
});

opsAuthRouterPg.delete('/ops/devices/:id', requireOpsAuth, async (req, res) => {
  const client = await getPgPool().connect();
  try {
    await client.query('BEGIN');
    const revoked = await client.query(
      `UPDATE operator_devices SET revoked_at = NOW()
        WHERE id = $1 AND operator_id = $2 AND revoked_at IS NULL RETURNING id`,
      [req.params.id, req.opsAuth!.operatorId],
    );
    if (!revoked.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Device not found.' });
    }
    await client.query(
      `UPDATE operator_sessions SET revoked_at = NOW(), revoke_reason = 'device_revoked'
        WHERE device_id = $1 AND revoked_at IS NULL`,
      [req.params.id],
    );
    await client.query('COMMIT');
    return res.json({ ok: true });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});
