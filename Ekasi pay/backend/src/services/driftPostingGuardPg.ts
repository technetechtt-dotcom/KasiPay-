import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { structuredLog } from '../observability.js';
import { inventoryWalletLedgerDriftPg } from './walletLedgerAlignmentPg.js';

const SYSTEM_RECON_GUARD = 'system:recon-guard';
const SYSTEM_DRIFT_GUARD = 'system:drift-guard';

async function ensureSystemOperator(
  client: PoolClient,
  id: string,
  username: string,
): Promise<void> {
  await client.query(
    `INSERT INTO ops_admin_users
       (id, username, password_hash, role, is_active, created_at, updated_at)
     VALUES ($1, $2, '!', 'operations', FALSE, clock_timestamp(), clock_timestamp())
     ON CONFLICT (id) DO NOTHING`,
    [id, username],
  );
}

/** Disable financial posting without inventoring drift (used by recon fail-closed). */
export async function disableFinancialPostingPg(
  database: Pool | PoolClient,
  reason: string,
  actorId: string = SYSTEM_RECON_GUARD,
): Promise<{ disabled: boolean }> {
  const client =
    'connect' in database ? await (database as Pool).connect() : (database as PoolClient);
  const ownsConnection = 'connect' in database;
  try {
    if (ownsConnection) await client.query('BEGIN');
    await ensureSystemOperator(client, SYSTEM_RECON_GUARD, 'system-recon-guard');
    await ensureSystemOperator(client, SYSTEM_DRIFT_GUARD, 'system-drift-guard');
    const current = await client.query<{ enabled: boolean }>(
      `SELECT enabled FROM operational_controls
        WHERE control_key = 'financial_posting' FOR UPDATE`,
    );
    const previous = current.rows[0]?.enabled;
    if (previous === undefined) {
      throw new Error('Posting control row is missing.');
    }
    let disabled = false;
    if (previous !== false) {
      await client.query(
        `UPDATE operational_controls
            SET enabled = FALSE, version = version + 1, reason = $1,
                changed_by = $2, changed_at = clock_timestamp()
          WHERE control_key = 'financial_posting'`,
        [reason, actorId],
      );
      await client.query(
        `INSERT INTO operational_control_events
           (id, control_key, previous_enabled, enabled, reason, actor_operator_id, request_id)
         VALUES ($1,'financial_posting',$2,FALSE,$3,$4,$5)`,
        [randomUUID(), previous, reason, actorId, randomUUID()],
      );
      disabled = true;
    }
    if (ownsConnection) await client.query('COMMIT');
    structuredLog('error', 'ledger.posting_kill_switch', {
      message: reason,
      postingDisabled: disabled || previous === false,
      alert: true,
      pageOnCall: true,
    });
    return { disabled: disabled || previous === false };
  } catch (error) {
    if (ownsConnection) await client.query('ROLLBACK');
    throw error;
  } finally {
    if (ownsConnection) client.release();
  }
}

/**
 * If any wallet↔legacy ledger drift exists, immediately disable financial posting
 * via operational_controls and emit an alert-ready structured log.
 */
export async function disablePostingOnLedgerDriftPg(
  database: Pool | PoolClient,
  reason = 'Automatic kill-switch: wallet/ledger drift detected',
): Promise<{ drifted: number; disabled: boolean }> {
  const drifted = await inventoryWalletLedgerDriftPg(database as PoolClient);
  if (drifted.length === 0) return { drifted: 0, disabled: false };
  const result = await disableFinancialPostingPg(
    database,
    reason,
    SYSTEM_DRIFT_GUARD,
  );
  structuredLog('error', 'ledger.drift_kill_switch', {
    message: reason,
    driftedWallets: drifted.length,
    sampleWalletIds: drifted.slice(0, 5).map((row) => row.walletId),
    postingDisabled: result.disabled,
    alert: true,
  });
  return { drifted: drifted.length, disabled: result.disabled };
}
