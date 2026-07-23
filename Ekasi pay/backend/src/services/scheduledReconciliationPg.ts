import { createHash, randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { structuredLog } from '../observability.js';
import { disablePostingOnLedgerDriftPg } from './driftPostingGuardPg.js';
import {
  classifyDriftOrigin,
  inventoryWalletLedgerDriftPg,
} from './walletLedgerAlignmentPg.js';

export type ReconcileRunType =
  | 'wallet_ledger'
  | 'money_columns'
  | 'journal'
  | 'projection'
  | 'vouchers'
  | 'fees'
  | 'commissions'
  | 'refunds'
  | 'settlement'
  | 'suspense'
  | 'full';

const DEFAULT_LEASE_SECONDS = 14 * 60;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

type CheckResult = {
  name: string;
  ok: boolean;
  critical: boolean;
  detail: Record<string, unknown>;
};

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Reconciliation check timed out: ${label}`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function acquireReconciliationLeasePg(
  database: PoolClient,
  jobKey: string,
  owner: string,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
): Promise<{ acquired: boolean; token: string | null }> {
  const token = randomUUID();
  const result = await database.query<{ lease_token: string }>(
    `INSERT INTO reconciliation_job_leases
       (job_key, lease_owner, lease_token, leased_until, last_started_at, last_status, updated_at)
     VALUES ($1,$2,$3,clock_timestamp() + ($4 * interval '1 second'), clock_timestamp(), 'running', clock_timestamp())
     ON CONFLICT (job_key) DO UPDATE
       SET lease_owner = EXCLUDED.lease_owner,
           lease_token = EXCLUDED.lease_token,
           leased_until = EXCLUDED.leased_until,
           last_started_at = EXCLUDED.last_started_at,
           last_status = 'running',
           updated_at = clock_timestamp()
     WHERE reconciliation_job_leases.leased_until < clock_timestamp()
        OR reconciliation_job_leases.lease_owner = EXCLUDED.lease_owner
     RETURNING lease_token`,
    [jobKey, owner, token, leaseSeconds],
  );
  if (!result.rows[0]) return { acquired: false, token: null };
  return { acquired: true, token: result.rows[0].lease_token };
}

export async function releaseReconciliationLeasePg(
  database: PoolClient,
  jobKey: string,
  token: string,
  status: string,
): Promise<void> {
  await database.query(
    `UPDATE reconciliation_job_leases
        SET leased_until = clock_timestamp(),
            last_completed_at = clock_timestamp(),
            last_status = $3,
            updated_at = clock_timestamp()
      WHERE job_key = $1 AND lease_token = $2`,
    [jobKey, token, status],
  );
}

async function checkWalletLedger(database: PoolClient): Promise<CheckResult> {
  const drifted = await inventoryWalletLedgerDriftPg(database);
  return {
    name: 'wallet_ledger',
    ok: drifted.length === 0,
    critical: true,
    detail: {
      driftedWallets: drifted.length,
      sample: drifted.slice(0, 10).map((row) => ({
        walletId: row.walletId,
        deltaCents: row.deltaCents.toString(),
        origin: row.origin,
      })),
    },
  };
}

async function checkJournalAndProjection(database: PoolClient): Promise<CheckResult> {
  const result = await database.query<{
    unbalanced: number;
    projection_mismatches: number;
    negative_balances: number;
    backfill_state: string | null;
  }>(`
    WITH posted AS (
      SELECT t.id,
        COALESCE(sum(e.amount_cents) FILTER (WHERE e.side = 'debit'), 0) debit,
        COALESCE(sum(e.amount_cents) FILTER (WHERE e.side = 'credit'), 0) credit
      FROM journal_transactions t
      LEFT JOIN journal_entries e ON e.transaction_id = t.id
      WHERE t.state IN ('posted','settled','reversed')
      GROUP BY t.id
    ), derived AS (
      SELECT a.id,
        COALESCE(sum(CASE
          WHEN t.id IS NULL THEN 0
          WHEN e.side = 'credit' THEN e.amount_cents
          ELSE -e.amount_cents
        END), 0) cents
      FROM ledger_accounts a
      LEFT JOIN journal_entries e ON e.account_id = a.id
      LEFT JOIN journal_transactions t ON t.id = e.transaction_id
        AND t.state IN ('posted','settled','reversed')
      GROUP BY a.id
    )
    SELECT
      (SELECT count(*) FROM posted WHERE debit = 0 OR debit <> credit)::int unbalanced,
      (SELECT count(*) FROM derived d JOIN account_balance_projections p
        ON p.account_id = d.id WHERE d.cents <> p.available_cents)::int projection_mismatches,
      (SELECT count(*) FROM account_balance_projections p
        JOIN ledger_accounts a ON a.id = p.account_id
        WHERE NOT a.allow_negative AND p.available_cents < 0)::int negative_balances,
      (SELECT state FROM ledger_backfill_status WHERE id = 1) backfill_state
  `);
  const row = result.rows[0];
  const ok =
    (row?.unbalanced ?? 1) === 0 &&
    (row?.projection_mismatches ?? 1) === 0 &&
    (row?.negative_balances ?? 1) === 0;
  return {
    name: 'journal_projection',
    ok,
    critical: true,
    detail: row ?? {},
  };
}

async function checkVouchers(database: PoolClient): Promise<CheckResult> {
  const exists = await database.query(
    `SELECT to_regclass('public.cash_send_vouchers') IS NOT NULL AS ok`,
  );
  if (!exists.rows[0]?.ok) {
    return { name: 'vouchers', ok: true, critical: false, detail: { skipped: true } };
  }
  const bad = await database.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM cash_send_vouchers
      WHERE status IN ('active','held') AND amount_cents < 0`,
  );
  return {
    name: 'vouchers',
    ok: (bad.rows[0]?.n ?? 0) === 0,
    critical: true,
    detail: { negativeActive: bad.rows[0]?.n ?? 0 },
  };
}

async function checkSuspense(database: PoolClient): Promise<CheckResult> {
  const result = await database.query<{ available_cents: string }>(
    `SELECT available_cents::text FROM account_balance_projections
      WHERE account_id = 'system:suspense:zar'`,
  );
  return {
    name: 'suspense',
    ok: true,
    critical: false,
    detail: { availableCents: result.rows[0]?.available_cents ?? null },
  };
}

async function openCriticalException(
  database: Pool | PoolClient,
  runId: string,
  check: CheckResult,
): Promise<void> {
  await database.query(
    `INSERT INTO reconciliation_exceptions
       (id, run_id, exception_type, severity, subject_type, subject_id, summary, evidence)
     VALUES ($1,$2,$3,'critical','reconciliation_check',$4,$5,$6::jsonb)`,
    [
      randomUUID(),
      runId,
      check.name,
      check.name,
      `Critical reconciliation failure: ${check.name}`,
      JSON.stringify(check.detail),
    ],
  );
}

/**
 * In-process reconciliation (no child-process spawn). Intended for a dedicated
 * worker/cron — not the API request path.
 */
export async function runScheduledReconciliationPg(
  pool: Pool,
  input: {
    runType?: ReconcileRunType;
    triggeredBy?: string;
    leaseSeconds?: number;
    timeoutMs?: number;
    maxAttempts?: number;
  } = {},
): Promise<{ runId: string; ok: boolean; driftedWallets: number; skipped?: boolean }> {
  const runType = input.runType ?? 'full';
  const jobKey = `reconcile:${runType}`;
  const owner = input.triggeredBy ?? `worker:${process.pid}`;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = input.maxAttempts ?? 3;

  const leaseClient = await pool.connect();
  let token: string | null = null;
  try {
    await leaseClient.query('BEGIN');
    const lease = await acquireReconciliationLeasePg(
      leaseClient,
      jobKey,
      owner,
      input.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
    );
    if (!lease.acquired || !lease.token) {
      await leaseClient.query('ROLLBACK');
      structuredLog('warn', 'reconciliation.lease_busy', { jobKey, owner });
      return { runId: '', ok: true, driftedWallets: 0, skipped: true };
    }
    token = lease.token;
    await leaseClient.query('COMMIT');
  } catch (error) {
    await leaseClient.query('ROLLBACK');
    throw error;
  } finally {
    leaseClient.release();
  }

  let attempt = 1;
  let lastError: unknown;
  while (attempt <= maxAttempts) {
    const runId = randomUUID();
    try {
      await pool.query(
        `INSERT INTO reconciliation_runs
           (id, run_type, state, triggered_by, lease_token, attempt)
         VALUES ($1,$2,'running',$3,$4,$5)`,
        [runId, runType, owner, token, attempt],
      );

      const checks: CheckResult[] = [];
      const runCheck = async (name: string, fn: () => Promise<CheckResult>) => {
        checks.push(await withTimeout(fn(), timeoutMs, name));
      };

      if (['full', 'wallet_ledger'].includes(runType)) {
        await runCheck('wallet_ledger', async () => {
          const client = await pool.connect();
          try {
            return await checkWalletLedger(client);
          } finally {
            client.release();
          }
        });
      }
      if (['full', 'journal', 'projection'].includes(runType)) {
        await runCheck('journal_projection', async () => {
          const client = await pool.connect();
          try {
            return await checkJournalAndProjection(client);
          } finally {
            client.release();
          }
        });
      }
      if (['full', 'vouchers'].includes(runType)) {
        await runCheck('vouchers', async () => {
          const client = await pool.connect();
          try {
            return await checkVouchers(client);
          } finally {
            client.release();
          }
        });
      }
      if (['full', 'suspense'].includes(runType)) {
        await runCheck('suspense', async () => {
          const client = await pool.connect();
          try {
            return await checkSuspense(client);
          } finally {
            client.release();
          }
        });
      }
      // Placeholder hooks for fee/commission/refund/settlement (extend with SQL as ledgers grow).
      for (const name of ['fees', 'commissions', 'refunds', 'settlement'] as const) {
        if (runType === 'full' || runType === name) {
          checks.push({ name, ok: true, critical: false, detail: { stub: true } });
        }
      }

      const driftClient = await pool.connect();
      let driftedWallets = 0;
      try {
        const drifted = await inventoryWalletLedgerDriftPg(driftClient);
        driftedWallets = drifted.length;
      } finally {
        driftClient.release();
      }

      const criticalFails = checks.filter((c) => !c.ok && c.critical);
      const anyFail = checks.filter((c) => !c.ok);
      if (criticalFails.length > 0 || driftedWallets > 0) {
        await disablePostingOnLedgerDriftPg(
          pool,
          'Automatic kill-switch: critical reconciliation failure',
        );
        for (const fail of criticalFails) {
          await openCriticalException(pool, runId, fail);
        }
        structuredLog('error', 'reconciliation.critical_failure', {
          runId,
          failed: criticalFails.map((c) => c.name),
          driftedWallets,
          alert: true,
        });
      }

      const state =
        criticalFails.length || driftedWallets > 0
          ? 'failed'
          : anyFail.length
            ? 'partial'
            : 'passed';
      await pool.query(
        `UPDATE reconciliation_runs
            SET state = $2, completed_at = clock_timestamp(), report = $3::jsonb
          WHERE id = $1`,
        [runId, state, JSON.stringify({ checks, driftedWallets })],
      );

      const release = await pool.connect();
      try {
        await releaseReconciliationLeasePg(release, jobKey, token!, state);
      } finally {
        release.release();
      }

      return {
        runId,
        ok: state === 'passed',
        driftedWallets,
      };
    } catch (error) {
      lastError = error;
      structuredLog('error', 'reconciliation.attempt_failed', {
        attempt,
        message: error instanceof Error ? error.message : 'unknown',
        alert: attempt >= maxAttempts,
      });
      attempt += 1;
      if (attempt <= maxAttempts) {
        await new Promise((r) => setTimeout(r, 250 * 2 ** (attempt - 2)));
      }
    }
  }

  const release = await pool.connect();
  try {
    await releaseReconciliationLeasePg(release, jobKey, token!, 'failed');
  } finally {
    release.release();
  }
  throw lastError instanceof Error ? lastError : new Error('Reconciliation failed');
}

export async function listOpenReconciliationExceptionsPg(
  database: Pool | PoolClient,
  limit = 100,
) {
  const result = await database.query(
    `SELECT * FROM reconciliation_exceptions
      WHERE state IN ('open','assigned','in_progress')
      ORDER BY CASE severity
        WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        created_at ASC
      LIMIT $1`,
    [limit],
  );
  return result.rows;
}

export async function createDriftRemediationProposalsPg(
  database: PoolClient,
  createdBy: string,
): Promise<{ proposals: number }> {
  const drifted = await inventoryWalletLedgerDriftPg(database);
  let proposals = 0;
  for (const row of drifted) {
    const projection = await database.query<{ available_cents: string }>(
      `SELECT p.available_cents::text
         FROM ledger_accounts a
         JOIN account_balance_projections p ON p.account_id = a.id
        WHERE a.wallet_id = $1`,
      [row.walletId],
    );
    const wallet = await database.query<{ currency: string; pool_id: string }>(
      `SELECT currency, COALESCE(pool_id,'ZA') AS pool_id FROM wallets WHERE id = $1`,
      [row.walletId],
    );
    const evidence = {
      walletId: row.walletId,
      walletKind: row.walletKind,
      balanceCents: row.balanceCents.toString(),
      legacyLedgerCents: row.legacyLedgerCents.toString(),
      deltaCents: row.deltaCents.toString(),
      origin: row.origin,
      projectionCents: projection.rows[0]?.available_cents ?? null,
      classifiedAt: new Date().toISOString(),
    };
    const digest = createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
    const origin = classifyDriftOrigin({
      walletId: row.walletId,
      walletKind: row.walletKind,
      deltaCents: row.deltaCents,
      legacyEntryCount: row.legacyEntryCount,
    });
    const inserted = await database.query(
      `INSERT INTO drift_remediation_proposals
         (id, wallet_id, currency, pool_id, wallet_balance_cents, legacy_ledger_cents,
          projection_cents, delta_cents, authoritative_side, origin, evidence,
          evidence_digest, expected_post_wallet_cents, expected_post_ledger_cents,
          created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'wallet',$9,$10::jsonb,$11,$5,$5,$12)
       ON CONFLICT (wallet_id) WHERE (state IN ('proposed','approved')) DO NOTHING
       RETURNING id`,
      [
        randomUUID(),
        row.walletId,
        wallet.rows[0]?.currency ?? 'ZAR',
        wallet.rows[0]?.pool_id ?? 'ZA',
        row.balanceCents.toString(),
        row.legacyLedgerCents.toString(),
        projection.rows[0]?.available_cents ?? null,
        row.deltaCents.toString(),
        origin,
        JSON.stringify(evidence),
        digest,
        createdBy,
      ],
    );
    if (inserted.rowCount) proposals += 1;
  }
  return { proposals };
}
