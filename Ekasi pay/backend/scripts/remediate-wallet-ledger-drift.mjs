/**
 * Inventory drift origins and optionally post alignment journals (ledger → wallet).
 * Never edits wallets.balance_cents directly.
 *
 * Dry-run (default):
 *   DATABASE_URL=... npm run money:remediate-drift
 *
 * Apply with maker-checker approval id (required in production):
 *   ALLOW_DRIFT_REMEDIATION=1 DRIFT_APPROVAL_REQUEST_ID=<uuid> npm run money:remediate-drift
 *
 * Non-prod staging fallback:
 *   ALLOW_DRIFT_REMEDIATION=1 DRIFT_REMEDIATION_APPROVAL=FIN-... npm run money:remediate-drift
 */
import 'dotenv/config';

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import pg from 'pg';

import {
  alignLegacyLedgerToWalletPg,
  inventoryWalletLedgerDriftPg,
} from '../src/services/walletLedgerAlignmentPg.ts';

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) throw new Error('DATABASE_URL is required.');
const apply = process.env.ALLOW_DRIFT_REMEDIATION === '1';
const approvalRequestId = process.env.DRIFT_APPROVAL_REQUEST_ID?.trim() ?? '';
const approval = process.env.DRIFT_REMEDIATION_APPROVAL?.trim() ?? '';
const nodeEnv = process.env.NODE_ENV?.trim() || 'development';
if (apply) {
  if (!approvalRequestId) {
    if (!(approval.length >= 8 && nodeEnv !== 'production')) {
      throw new Error(
        'Set DRIFT_APPROVAL_REQUEST_ID (or non-prod DRIFT_REMEDIATION_APPROVAL).',
      );
    }
    console.warn(
      '[remediate-drift] Using DRIFT_REMEDIATION_APPROVAL fallback — production must use DRIFT_APPROVAL_REQUEST_ID.',
    );
  }
}

const hostname = new URL(connectionString).hostname;
const local = ['localhost', '127.0.0.1', '::1'].includes(hostname);
const client = new pg.Client({
  connectionString,
  ssl: local
    ? false
    : {
        rejectUnauthorized:
          process.env.PG_SSL_REJECT_UNAUTHORIZED?.toLowerCase() !== 'false',
      },
});

await client.connect();
try {
  const before = await inventoryWalletLedgerDriftPg(client);
  const applied = [];
  if (apply && before.length > 0) {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    try {
      if (approvalRequestId) {
        const { lockApprovedRequest, markApprovalExecuted } = await import(
          '../src/security/approvalsPg.ts'
        );
        const meta = await client.query(
          `SELECT resource_id, payload FROM approval_requests
            WHERE id = $1 AND state = 'approved' FOR UPDATE`,
          [approvalRequestId],
        );
        const row = meta.rows[0];
        if (!row) throw new Error('Approved balance_adjustment request not found.');
        const batch = row.payload?.batch === true;
        const allowed = new Set(
          batch
            ? (row.payload.walletIds ?? before.map((w) => w.walletId))
            : [row.resource_id],
        );
        await lockApprovedRequest(client, {
          approvalRequestId,
          actionType: 'balance_adjustment',
          resourceType: batch ? 'wallet_batch' : 'wallet',
          resourceId: row.resource_id,
          executorOperatorId: 'script:remediate-drift',
        });
        for (const drift of before) {
          if (!allowed.has(drift.walletId)) {
            throw new Error(`Wallet ${drift.walletId} is not covered by the approval.`);
          }
          const result = await alignLegacyLedgerToWalletPg(client, {
            walletId: drift.walletId,
            approvalReference: approvalRequestId,
            actorId: 'script:remediate-drift',
            reason: `Align legacy ledger to wallet (${drift.origin}); approval ${approvalRequestId}`,
          });
          applied.push({
            walletId: drift.walletId,
            origin: drift.origin,
            deltaBefore: drift.deltaCents.toString(),
            ...result,
          });
        }
        await markApprovalExecuted(
          client,
          approvalRequestId,
          'script:remediate-drift',
          'Batch drift remediation executed',
        );
      } else {
        for (const row of before) {
          const result = await alignLegacyLedgerToWalletPg(client, {
            walletId: row.walletId,
            approvalReference: approval,
            actorId: `remediation:${approval}`,
            reason: `Align legacy ledger to wallet (${row.origin}); approval ${approval}`,
          });
          applied.push({
            walletId: row.walletId,
            origin: row.origin,
            deltaBefore: row.deltaCents.toString(),
            ...result,
          });
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  const after = await inventoryWalletLedgerDriftPg(client);
  const report = {
    schemaVersion: 'phase3.wallet_ledger_drift_remediation.v1',
    generatedAt: new Date().toISOString(),
    mode: apply ? 'apply' : 'dry-run',
    approvalRequestId: apply ? approvalRequestId || null : null,
    approvalReference: apply ? approval || approvalRequestId || null : null,
    before: {
      driftedWallets: before.length,
      rows: before.map((row) => ({
        walletId: row.walletId,
        walletKind: row.walletKind,
        balanceCents: row.balanceCents.toString(),
        legacyLedgerCents: row.legacyLedgerCents.toString(),
        deltaCents: row.deltaCents.toString(),
        legacyEntryCount: row.legacyEntryCount,
        origin: row.origin,
      })),
    },
    applied,
    after: {
      driftedWallets: after.length,
      rows: after.map((row) => ({
        walletId: row.walletId,
        deltaCents: row.deltaCents.toString(),
        origin: row.origin,
      })),
    },
    ok: after.length === 0,
  };

  const outDir = path.resolve('artifacts');
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(
    outDir,
    `wallet-ledger-drift-remediation-${Date.now()}.json`,
  );
  writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, evidenceFile: outFile }, null, 2));
  if (!report.ok && apply) process.exitCode = 2;
  if (!apply && before.length > 0) process.exitCode = 2;
} finally {
  await client.end();
}
