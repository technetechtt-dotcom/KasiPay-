import { createHmac, randomBytes, randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

const REFRESH_TTL_MS = 24 * 60 * 60 * 1000;
const ABSOLUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function pepper(): string {
  const value = process.env.OPS_REFRESH_TOKEN_PEPPER?.trim() ?? '';
  if (process.env.NODE_ENV === 'production' && value.length < 32) {
    throw new Error('OPS_REFRESH_TOKEN_PEPPER must be at least 32 characters');
  }
  return value || 'development-operator-refresh-pepper';
}

export function hashOperatorRefresh(raw: string): string {
  return createHmac('sha256', pepper()).update(raw).digest('hex');
}

function refreshRaw(): string {
  return randomBytes(48).toString('base64url');
}

export async function createOperatorSession(
  pool: Pool,
  operatorId: string,
  tokenVersion: number,
  device?: { installId?: string; label?: string; platform?: string },
): Promise<{ id: string; refreshToken: string }> {
  const id = randomUUID();
  const familyId = randomUUID();
  const raw = refreshRaw();
  let deviceId: string | null = null;
  if (device?.installId) {
    const installHash = createHmac('sha256', pepper()).update(device.installId).digest('hex');
    const found = await pool.query<{ id: string }>(
      `INSERT INTO operator_devices
        (id, operator_id, install_id_hash, label, platform)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (operator_id, install_id_hash) DO UPDATE
         SET label = EXCLUDED.label, platform = EXCLUDED.platform, last_seen_at = NOW()
       RETURNING id`,
      [randomUUID(), operatorId, installHash, device.label ?? 'Unknown device', device.platform ?? null],
    );
    deviceId = found.rows[0]?.id ?? null;
  }
  const now = Date.now();
  await pool.query(
    `INSERT INTO operator_sessions
      (id, operator_id, family_id, refresh_token_hash, token_version, device_id,
       expires_at, absolute_expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      id, operatorId, familyId, hashOperatorRefresh(raw), tokenVersion, deviceId,
      new Date(now + REFRESH_TTL_MS), new Date(now + ABSOLUTE_TTL_MS),
    ],
  );
  return { id, refreshToken: raw };
}

export async function rotateOperatorRefresh(pool: Pool, raw: string) {
  const hash = hashOperatorRefresh(raw);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<{
      id: string; operator_id: string; family_id: string; token_version: number;
      absolute_expires_at: Date;
    }>(
      `SELECT id, operator_id, family_id, token_version, absolute_expires_at
         FROM operator_sessions
        WHERE refresh_token_hash = $1 AND revoked_at IS NULL
          AND expires_at > NOW() AND absolute_expires_at > NOW()
        FOR UPDATE`,
      [hash],
    );
    const row = current.rows[0];
    if (!row) {
      const reused = await client.query<{ family_id: string }>(
        `SELECT family_id FROM operator_refresh_history WHERE token_hash = $1
         UNION ALL
         SELECT family_id FROM operator_sessions
          WHERE previous_refresh_hash = $1 OR refresh_token_hash = $1
         LIMIT 1`,
        [hash],
      );
      if (reused.rows[0]) {
        await client.query(
          `UPDATE operator_sessions SET revoked_at = NOW(), revoke_reason = 'refresh_family_reuse'
            WHERE family_id = $1 AND revoked_at IS NULL`,
          [reused.rows[0].family_id],
        );
      }
      await client.query('COMMIT');
      return null;
    }
    const next = refreshRaw();
    await client.query(
      `INSERT INTO operator_refresh_history (token_hash, session_id, family_id)
       VALUES ($1,$2,$3)`,
      [hash, row.id, row.family_id],
    );
    await client.query(
      `UPDATE operator_sessions
          SET previous_refresh_hash = refresh_token_hash,
              refresh_token_hash = $1, expires_at = LEAST($2, absolute_expires_at),
              last_seen_at = NOW()
        WHERE id = $3`,
      [hashOperatorRefresh(next), new Date(Date.now() + REFRESH_TTL_MS), row.id],
    );
    await client.query('COMMIT');
    return { ...row, refreshToken: next };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function revokeOperatorSessions(pool: Pool, operatorId: string, reason: string) {
  await pool.query(
    `UPDATE operator_sessions SET revoked_at = NOW(), revoke_reason = $2
      WHERE operator_id = $1 AND revoked_at IS NULL`,
    [operatorId, reason],
  );
}
