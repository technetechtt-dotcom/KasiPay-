import { createHash, randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { structuredLog } from '../observability.js';
import { disableFinancialPostingPg } from './driftPostingGuardPg.js';
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
  | 'provider_instructions'
  | 'suspense'
  | 'loans'
  | 'insurance'
  | 'full';

const DEFAULT_LEASE_SECONDS = 14 * 60;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

type CheckResult = {
  name: string;
  ok: boolean;
  /** Money-integrity checks are always critical and never allowed as soft/partial. */
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

async function tableExists(database: PoolClient, name: string): Promise<boolean> {
  const result = await database.query<{ ok: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS ok`,
    [`public.${name}`],
  );
  return Boolean(result.rows[0]?.ok);
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

async function checkJournal(database: PoolClient): Promise<CheckResult> {
  const result = await database.query<{ unbalanced: number }>(`
    WITH posted AS (
      SELECT t.id,
        COALESCE(sum(e.amount_cents) FILTER (WHERE e.side = 'debit'), 0) debit,
        COALESCE(sum(e.amount_cents) FILTER (WHERE e.side = 'credit'), 0) credit
      FROM journal_transactions t
      LEFT JOIN journal_entries e ON e.transaction_id = t.id
      WHERE t.state IN ('posted','settled','reversed')
      GROUP BY t.id
    )
    SELECT (SELECT count(*) FROM posted WHERE debit = 0 OR debit <> credit)::int unbalanced
  `);
  const unbalanced = result.rows[0]?.unbalanced ?? 1;
  return {
    name: 'journal',
    ok: unbalanced === 0,
    critical: true,
    detail: { unbalanced },
  };
}

async function checkProjection(database: PoolClient): Promise<CheckResult> {
  const result = await database.query<{
    projection_mismatches: number;
    negative_balances: number;
  }>(`
    WITH derived AS (
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
      (SELECT count(*) FROM derived d JOIN account_balance_projections p
        ON p.account_id = d.id WHERE d.cents <> p.available_cents)::int projection_mismatches,
      (SELECT count(*) FROM account_balance_projections p
        JOIN ledger_accounts a ON a.id = p.account_id
        WHERE NOT a.allow_negative AND p.available_cents < 0)::int negative_balances
  `);
  const row = result.rows[0];
  const ok =
    (row?.projection_mismatches ?? 1) === 0 && (row?.negative_balances ?? 1) === 0;
  return {
    name: 'projection',
    ok,
    critical: true,
    detail: row ?? {},
  };
}

async function checkVouchers(database: PoolClient): Promise<CheckResult> {
  if (!(await tableExists(database, 'cash_send_vouchers'))) {
    return { name: 'vouchers', ok: true, critical: true, detail: { skipped: true } };
  }
  const bad = await database.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM cash_send_vouchers
      WHERE status IN ('active','held') AND amount_cents < 0`,
  );
  return {
    name: 'vouchers',
    ok: (bad.rows[0]?.n ?? 0) === 0,
    critical: true,
    detail: { invalidRows: bad.rows[0]?.n ?? 0 },
  };
}

async function checkSuspense(database: PoolClient): Promise<CheckResult> {
  const result = await database.query<{ available_cents: string }>(
    `SELECT available_cents::text FROM account_balance_projections
      WHERE account_id = 'system:suspense:zar'`,
  );
  const available = BigInt(result.rows[0]?.available_cents ?? '0');
  // Non-zero suspense is an open remediation incident until cleared.
  return {
    name: 'suspense',
    ok: available === 0n,
    critical: true,
    detail: { availableCents: available.toString() },
  };
}

async function checkFees(database: PoolClient): Promise<CheckResult> {
  if (!(await tableExists(database, 'fee_schedules'))) {
    return { name: 'fees', ok: true, critical: true, detail: { skipped: true } };
  }
  const bad = await database.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM fee_schedule_tiers
      WHERE flat_cents < 0 OR rate_basis_points < 0 OR min_fee_cents < 0`,
  );
  return {
    name: 'fees',
    ok: (bad.rows[0]?.n ?? 0) === 0,
    critical: true,
    detail: { invalidTiers: bad.rows[0]?.n ?? 0 },
  };
}

async function checkCommissions(database: PoolClient): Promise<CheckResult> {
  if (!(await tableExists(database, 'commission_postings'))) {
    return { name: 'commissions', ok: true, critical: true, detail: { skipped: true } };
  }
  const bad = await database.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM commission_postings WHERE amount_cents < 0`,
  );
  return {
    name: 'commissions',
    ok: (bad.rows[0]?.n ?? 0) === 0,
    critical: true,
    detail: { negativePostings: bad.rows[0]?.n ?? 0 },
  };
}

async function checkRefunds(database: PoolClient): Promise<CheckResult> {
  if (!(await tableExists(database, 'refund_requests'))) {
    return { name: 'refunds', ok: true, critical: true, detail: { skipped: true } };
  }
  const bad = await database.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM refund_requests
      WHERE requested_cents <= 0
         OR state NOT IN (
           'requested','pending_approval','approved','posted','rejected','failed'
         )`,
  );
  return {
    name: 'refunds',
    ok: (bad.rows[0]?.n ?? 0) === 0,
    critical: true,
    detail: { invalidRows: bad.rows[0]?.n ?? 0 },
  };
}

async function checkSettlement(database: PoolClient): Promise<CheckResult> {
  if (!(await tableExists(database, 'settlement_suspense_cases'))) {
    return { name: 'settlement', ok: true, critical: true, detail: { skipped: true } };
  }
  const open = await database.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM settlement_suspense_cases
      WHERE state IN ('open','pending_approval')`,
  );
  return {
    name: 'settlement',
    ok: (open.rows[0]?.n ?? 0) === 0,
    critical: true,
    detail: { openSuspenseCases: open.rows[0]?.n ?? 0 },
  };
}

async function checkProviderInstructions(database: PoolClient): Promise<CheckResult> {
  if (!(await tableExists(database, 'provider_instructions'))) {
    return {
      name: 'provider_instructions',
      ok: true,
      critical: true,
      detail: { skipped: true },
    };
  }
  const stuck = await database.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM provider_instructions
      WHERE state IN ('submitted','accepted')
        AND created_at < clock_timestamp() - interval '24 hours'`,
  );
  return {
    name: 'provider_instructions',
    ok: (stuck.rows[0]?.n ?? 0) === 0,
    critical: true,
    detail: { stuckOver24h: stuck.rows[0]?.n ?? 0 },
  };
}

async function checkLoans(database: PoolClient): Promise<CheckResult> {
  if (!(await tableExists(database, 'regulated_loans'))) {
    return { name: 'loans', ok: true, critical: true, detail: { skipped: true } };
  }
  const bad = await database.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM regulated_loans
      WHERE principal_cents < 0
         OR principal_outstanding_cents < 0
         OR interest_outstanding_cents < 0
         OR fee_outstanding_cents < 0`,
  );
  return {
    name: 'loans',
    ok: (bad.rows[0]?.n ?? 0) === 0,
    critical: true,
    detail: { invalidRows: bad.rows[0]?.n ?? 0 },
  };
}

async function checkInsurance(database: PoolClient): Promise<CheckResult> {
  if (!(await tableExists(database, 'regulated_insurance_policies'))) {
    return { name: 'insurance', ok: true, critical: true, detail: { skipped: true } };
  }
  const bad = await database.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM insurance_premium_collections
      WHERE amount_cents < 0`,
  );
  return {
    name: 'insurance',
    ok: (bad.rows[0]?.n ?? 0) === 0,
    critical: true,
    detail: { invalidPremiums: bad.rows[0]?.n ?? 0 },
  };
}

async function openCriticalException(
  database: Pool | PoolClient,
  runId: string,
  check: CheckResult,
): Promise<string> {
  const id = randomUUID();
  await database.query(
    `INSERT INTO reconciliation_exceptions
       (id, run_id, exception_type, severity, subject_type, subject_id, summary, evidence)
     VALUES ($1,$2,$3,'critical','reconciliation_check',$4,$5,$6::jsonb)`,
    [
      id,
      runId,
      check.name,
      check.name,
      `Critical reconciliation failure: ${check.name}`,
      JSON.stringify(check.detail),
    ],
  );
  return id;
}

async function notifyOnCallOperator(
  database: Pool | PoolClient,
  input: {
    source: string;
    subjectType: string;
    subjectId: string;
    summary: string;
    evidence: Record<string, unknown>;
  },
): Promise<void> {
  const id = randomUUID();
  const exists = await database.query(
    `SELECT to_regclass('public.on_call_alerts') IS NOT NULL AS ok`,
  );
  if (exists.rows[0]?.ok) {
    await database.query(
      `INSERT INTO on_call_alerts
         (id, severity, source, subject_type, subject_id, summary, evidence)
       VALUES ($1,'critical',$2,$3,$4,$5,$6::jsonb)`,
      [
        id,
        input.source,
        input.subjectType,
        input.subjectId,
        input.summary,
        JSON.stringify(input.evidence),
      ],
    );
  }
  structuredLog('error', 'on_call.alert', {
    alertId: id,
    ...input,
    alert: true,
    pageOnCall: true,
  });
}

export async function enqueueReconciliationJobPg(
  database: Pool | PoolClient,
  input: { runType: ReconcileRunType; requestedBy: string },
): Promise<{ requestId: string }> {
  const id = randomUUID();
  await database.query(
    `INSERT INTO reconciliation_job_requests (id, run_type, requested_by, state)
     VALUES ($1,$2,$3,'queued')`,
    [id, input.runType, input.requestedBy],
  );
  structuredLog('info', 'reconciliation.enqueued', {
    requestId: id,
    runType: input.runType,
    requestedBy: input.requestedBy,
  });
  return { requestId: id };
}

export async function claimQueuedReconciliationJobsPg(
  pool: Pool,
  workerId: string,
  limit = 5,
): Promise<Array<{ id: string; runType: ReconcileRunType }>> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rows = await client.query<{ id: string; run_type: ReconcileRunType }>(
      `WITH next AS (
         SELECT id FROM reconciliation_job_requests
          WHERE state = 'queued'
          ORDER BY created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $1
       )
       UPDATE reconciliation_job_requests r
          SET state = 'claimed', claimed_by = $2, claimed_at = clock_timestamp()
         FROM next WHERE r.id = next.id
       RETURNING r.id, r.run_type`,
      [limit, workerId],
    );
    await client.query('COMMIT');
    return rows.rows.map((r) => ({ id: r.id, runType: r.run_type }));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Worker-only reconciliation. Never call from the API request path.
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
      const withClient = async (fn: (c: PoolClient) => Promise<CheckResult>) => {
        const client = await pool.connect();
        try {
          return await fn(client);
        } finally {
          client.release();
        }
      };

      if (['full', 'wallet_ledger'].includes(runType)) {
        await runCheck('wallet_ledger', () => withClient(checkWalletLedger));
      }
      if (['full', 'journal'].includes(runType)) {
        await runCheck('journal', () => withClient(checkJournal));
      }
      if (['full', 'projection'].includes(runType)) {
        await runCheck('projection', () => withClient(checkProjection));
      }
      if (['full', 'vouchers'].includes(runType)) {
        await runCheck('vouchers', () => withClient(checkVouchers));
      }
      if (['full', 'fees'].includes(runType)) {
        await runCheck('fees', () => withClient(checkFees));
      }
      if (['full', 'commissions'].includes(runType)) {
        await runCheck('commissions', () => withClient(checkCommissions));
      }
      if (['full', 'refunds'].includes(runType)) {
        await runCheck('refunds', () => withClient(checkRefunds));
      }
      if (['full', 'settlement'].includes(runType)) {
        await runCheck('settlement', () => withClient(checkSettlement));
      }
      if (['full', 'provider_instructions'].includes(runType)) {
        await runCheck('provider_instructions', () =>
          withClient(checkProviderInstructions),
        );
      }
      if (['full', 'suspense'].includes(runType)) {
        await runCheck('suspense', () => withClient(checkSuspense));
      }
      if (['full', 'loans'].includes(runType)) {
        await runCheck('loans', () => withClient(checkLoans));
      }
      if (['full', 'insurance'].includes(runType)) {
        await runCheck('insurance', () => withClient(checkInsurance));
      }

      const criticalFails = checks.filter((c) => !c.ok);
      // Any money-integrity failure fails closed — never "partial".
      let driftedWallets = 0;
      if (['full', 'wallet_ledger'].includes(runType)) {
        const walletCheck = checks.find((c) => c.name === 'wallet_ledger');
        driftedWallets = Number(walletCheck?.detail.driftedWallets ?? 0);
      }

      if (criticalFails.length > 0) {
        await disableFinancialPostingPg(
          pool,
          `Automatic kill-switch: critical reconciliation failure (${criticalFails
            .map((c) => c.name)
            .join(',')})`,
        );
        for (const fail of criticalFails) {
          const exceptionId = await openCriticalException(pool, runId, fail);
          await notifyOnCallOperator(pool, {
            source: 'reconciliation',
            subjectType: 'reconciliation_exception',
            subjectId: exceptionId,
            summary: `Critical reconciliation failure: ${fail.name}`,
            evidence: { runId, check: fail },
          });
        }
        structuredLog('error', 'reconciliation.critical_failure', {
          runId,
          failed: criticalFails.map((c) => c.name),
          driftedWallets,
          alert: true,
          pageOnCall: true,
        });
      }

      const state = criticalFails.length > 0 ? 'failed' : 'passed';
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
        pageOnCall: attempt >= maxAttempts,
      });
      try {
        await disableFinancialPostingPg(
          pool,
          'Automatic kill-switch: reconciliation threw before completion',
        );
      } catch {
        /* still rethrow below */
      }
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

function stableEvidenceDigest(evidence: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
}

export async function createDriftRemediationProposalsPg(
  database: PoolClient,
  createdBy: string,
): Promise<{ proposals: number }> {
  const drifted = await inventoryWalletLedgerDriftPg(database);
  let proposals = 0;
  for (const row of drifted) {
    const account = await database.query<{
      account_id: string;
      projection_cents: string | null;
      journal_derived_cents: string | null;
    }>(
      `SELECT a.id AS account_id,
              p.available_cents::text AS projection_cents,
              (
                SELECT COALESCE(sum(CASE
                  WHEN t.state IS NULL THEN 0
                  WHEN e.side = 'credit' THEN e.amount_cents
                  ELSE -e.amount_cents END), 0)::text
                  FROM journal_entries e
                  LEFT JOIN journal_transactions t ON t.id = e.transaction_id
                   AND t.state IN ('posted','settled','reversed')
                 WHERE e.account_id = a.id
              ) AS journal_derived_cents
         FROM ledger_accounts a
         LEFT JOIN account_balance_projections p ON p.account_id = a.id
        WHERE a.wallet_id = $1
        LIMIT 1`,
      [row.walletId],
    );
    const wallet = await database.query<{ currency: string; pool_id: string }>(
      `SELECT currency, COALESCE(pool_id,'ZA') AS pool_id FROM wallets WHERE id = $1`,
      [row.walletId],
    );
    const currency = wallet.rows[0]?.currency ?? 'ZAR';
    const poolId = wallet.rows[0]?.pool_id ?? 'ZA';
    const walletAccountId = account.rows[0]?.account_id ?? null;
    const suspenseId =
      currency === 'ZAR' && poolId === 'ZA' ? 'system:suspense:zar' : null;
    const delta = row.deltaCents;
    const debitAccountId =
      delta > 0n ? suspenseId : walletAccountId;
    const creditAccountId =
      delta > 0n ? walletAccountId : suspenseId;
    const origin = classifyDriftOrigin({
      walletId: row.walletId,
      walletKind: row.walletKind,
      deltaCents: row.deltaCents,
      legacyEntryCount: row.legacyEntryCount,
    });
    const evidence = {
      walletId: row.walletId,
      walletKind: row.walletKind,
      currency,
      poolId,
      walletBalanceCents: row.balanceCents.toString(),
      journalBalanceCents: account.rows[0]?.journal_derived_cents ?? null,
      legacyLedgerCents: row.legacyLedgerCents.toString(),
      projectionBalanceCents: account.rows[0]?.projection_cents ?? null,
      deltaCents: row.deltaCents.toString(),
      debitAccountId,
      creditAccountId,
      rootCause: origin,
      origin,
      classifiedAt: new Date().toISOString(),
    };
    const digest = stableEvidenceDigest(evidence);
    const inserted = await database.query(
      `INSERT INTO drift_remediation_proposals
         (id, wallet_id, currency, pool_id, wallet_balance_cents, legacy_ledger_cents,
          projection_cents, journal_derived_cents, delta_cents, authoritative_side, origin,
          evidence, evidence_digest, expected_post_wallet_cents, expected_post_ledger_cents,
          created_by, debit_account_id, credit_account_id, root_cause)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'wallet',$10,$11::jsonb,$12,$5,$5,$13,$14,$15,$10)
       ON CONFLICT (wallet_id) WHERE (state IN ('proposed','approved')) DO NOTHING
       RETURNING id`,
      [
        randomUUID(),
        row.walletId,
        currency,
        poolId,
        row.balanceCents.toString(),
        row.legacyLedgerCents.toString(),
        account.rows[0]?.projection_cents ?? null,
        account.rows[0]?.journal_derived_cents ?? null,
        row.deltaCents.toString(),
        origin,
        JSON.stringify(evidence),
        digest,
        createdBy,
        debitAccountId,
        creditAccountId,
      ],
    );
    if (inserted.rowCount) proposals += 1;
  }
  return { proposals };
}

/**
 * Reject execution when live balances no longer match the approved proposal digest.
 */
export async function assertDriftProposalUnchangedPg(
  database: PoolClient,
  proposalId: string,
): Promise<{
  walletId: string;
  evidenceDigest: string;
  walletBalanceCents: string;
  deltaCents: string;
}> {
  const proposal = await database.query<{
    wallet_id: string;
    evidence: Record<string, unknown>;
    evidence_digest: string;
    approved_evidence_digest: string | null;
    wallet_balance_cents: string;
    legacy_ledger_cents: string;
    projection_cents: string | null;
    journal_derived_cents: string | null;
    delta_cents: string;
    currency: string;
    pool_id: string;
    debit_account_id: string | null;
    credit_account_id: string | null;
    root_cause: string | null;
    origin: string;
    state: string;
  }>(`SELECT * FROM drift_remediation_proposals WHERE id = $1 FOR UPDATE`, [
    proposalId,
  ]);
  const row = proposal.rows[0];
  if (!row) {
    throw Object.assign(new Error('Drift remediation proposal not found.'), {
      status: 404,
      code: 'PROPOSAL_NOT_FOUND',
    });
  }
  if (!['proposed', 'approved'].includes(row.state)) {
    throw Object.assign(new Error(`Proposal state ${row.state} is not executable.`), {
      status: 409,
      code: 'PROPOSAL_STATE',
    });
  }

  const liveDrift = await inventoryWalletLedgerDriftPg(database);
  const match = liveDrift.find((d) => d.walletId === row.wallet_id);
  const wallet = await database.query<{ balance_cents: string }>(
    `SELECT balance_cents FROM wallets WHERE id = $1`,
    [row.wallet_id],
  );
  const account = await database.query<{
    projection_cents: string | null;
    journal_derived_cents: string | null;
  }>(
    `SELECT p.available_cents::text AS projection_cents,
            (
              SELECT COALESCE(sum(CASE
                WHEN t.state IS NULL THEN 0
                WHEN e.side = 'credit' THEN e.amount_cents
                ELSE -e.amount_cents END), 0)::text
                FROM journal_entries e
                LEFT JOIN journal_transactions t ON t.id = e.transaction_id
                 AND t.state IN ('posted','settled','reversed')
               WHERE e.account_id = a.id
            ) AS journal_derived_cents
       FROM ledger_accounts a
       LEFT JOIN account_balance_projections p ON p.account_id = a.id
      WHERE a.wallet_id = $1
      LIMIT 1`,
    [row.wallet_id],
  );

  const liveSnapshot = {
    walletBalanceCents: wallet.rows[0]?.balance_cents ?? '0',
    legacyLedgerCents: (match?.legacyLedgerCents ?? BigInt(row.legacy_ledger_cents)).toString(),
    journalBalanceCents: account.rows[0]?.journal_derived_cents ?? null,
    projectionBalanceCents: account.rows[0]?.projection_cents ?? null,
    deltaCents: (match?.deltaCents ?? 0n).toString(),
    currency: row.currency,
    debitAccountId: row.debit_account_id,
    creditAccountId: row.credit_account_id,
  };
  const approvedSnapshot = {
    walletBalanceCents: row.wallet_balance_cents,
    legacyLedgerCents: row.legacy_ledger_cents,
    journalBalanceCents: row.journal_derived_cents,
    projectionBalanceCents: row.projection_cents,
    deltaCents: row.delta_cents,
    currency: row.currency,
    debitAccountId: row.debit_account_id,
    creditAccountId: row.credit_account_id,
  };

  const expectedDigest = row.approved_evidence_digest || row.evidence_digest;
  if (JSON.stringify(liveSnapshot) !== JSON.stringify(approvedSnapshot)) {
    throw Object.assign(
      new Error(
        'Approved drift proposal no longer matches live wallet/journal/projection values.',
      ),
      {
        status: 409,
        code: 'PROPOSAL_EVIDENCE_CHANGED',
        expectedDigest,
        live: liveSnapshot,
        approved: approvedSnapshot,
      },
    );
  }

  return {
    walletId: row.wallet_id,
    evidenceDigest: expectedDigest,
    walletBalanceCents: row.wallet_balance_cents,
    deltaCents: row.delta_cents,
  };
}
