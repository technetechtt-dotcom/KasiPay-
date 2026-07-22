/**
 * Re-run wallet/ledger + money + journal reconcile for N consecutive cycles.
 * Exit 0 only when every cycle reports zero wallet↔legacy drift and balanced journals.
 *
 * `ledger_backfill_status=pending_signoff` is reported but does not fail this proof —
 * that remains a separate finance gate (`ALLOW_LEDGER_BACKFILL=1`).
 *
 *   DATABASE_URL=... npm run money:prove-zero-drift
 *   DRIFT_PROOF_CYCLES=5 DATABASE_URL=... npm run money:prove-zero-drift
 */
import 'dotenv/config';

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const cycles = Math.max(
  3,
  Number(process.env.DRIFT_PROOF_CYCLES?.trim() || '3') || 3,
);
const results = [];

function runNode(script) {
  return spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: process.env,
  });
}

function parseLedgerReport(stdout) {
  try {
    const start = stdout.indexOf('{');
    const end = stdout.lastIndexOf('}');
    if (start < 0 || end < start) return null;
    return JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return null;
  }
}

for (let i = 1; i <= cycles; i += 1) {
  const inventory = runNode('scripts/inventory-wallet-ledger-drift.mjs');
  const money = runNode('scripts/reconcile-money.mjs');
  const ledger = runNode('scripts/reconcile-ledger.mjs');
  const ledgerReport = parseLedgerReport(ledger.stdout ?? '');
  const journalOk =
    ledgerReport &&
    ledgerReport.unbalanced === 0 &&
    ledgerReport.projection_mismatches === 0 &&
    ledgerReport.negative_balances === 0;
  const cycle = {
    cycle: i,
    inventoryExit: inventory.status ?? 1,
    moneyExit: money.status ?? 1,
    ledgerExit: ledger.status ?? 1,
    journalBalanced: Boolean(journalOk),
    backfillState: ledgerReport?.backfill_state ?? null,
    ok:
      (inventory.status ?? 1) === 0 &&
      (money.status ?? 1) === 0 &&
      Boolean(journalOk),
  };
  results.push(cycle);
  if (!cycle.ok) break;
}

const report = {
  schemaVersion: 'phase3.zero_drift_proof.v1',
  generatedAt: new Date().toISOString(),
  requestedCycles: cycles,
  completedCycles: results.length,
  consecutiveOk: results.every((row) => row.ok) && results.length >= cycles,
  results,
  notes: [
    'Wallet↔legacy drift must be zero each cycle.',
    'Journal debit=credit, projection match, and non-negative balances required.',
    'ledger_backfill_status=pending_signoff remains a separate finance gate.',
  ],
};
const outDir = path.resolve('artifacts');
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `zero-drift-proof-${Date.now()}.json`);
writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, evidenceFile: outFile }, null, 2));
if (!report.consecutiveOk) process.exitCode = 2;
