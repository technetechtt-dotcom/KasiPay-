/**
 * Inventory drift origins and optionally post alignment journals (ledger → wallet).
 * Never edits wallets.balance_cents directly.
 *
 * Dry-run (default):
 *   DATABASE_URL=... npm run money:remediate-drift
 *
 * Apply (requires finance approval reference):
 *   ALLOW_DRIFT_REMEDIATION=1 DRIFT_REMEDIATION_APPROVAL=FIN-2026-... \
 *     DATABASE_URL=... npm run money:remediate-drift
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
const approval = process.env.DRIFT_REMEDIATION_APPROVAL?.trim() ?? '';
if (apply && approval.length < 8) {
  throw new Error(
    'DRIFT_REMEDIATION_APPROVAL (min 8 chars) is required when ALLOW_DRIFT_REMEDIATION=1.',
  );
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
    approvalReference: apply ? approval : null,
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
    nextSteps: after.length
      ? [
          'Review dry-run origins, obtain finance approval, then re-run with ALLOW_DRIFT_REMEDIATION=1.',
          'After apply, run npm run money:prove-zero-drift for consecutive reconcile cycles.',
        ]
      : [
          'Run npm run money:prove-zero-drift to demonstrate consecutive zero-drift cycles.',
          'Keep FINANCIAL_POSTING_ENABLED=false until production evidence is signed.',
        ],
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
