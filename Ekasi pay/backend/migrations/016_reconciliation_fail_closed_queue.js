/**
 * Expand reconciliation run types, job queue, on-call alerts, and proposal accounts.
 */
export const up = (pgm) => {
  pgm.sql(`
    UPDATE reconciliation_runs SET state = 'failed' WHERE state = 'partial';

    ALTER TABLE reconciliation_runs DROP CONSTRAINT IF EXISTS reconciliation_runs_run_type_check;
    ALTER TABLE reconciliation_runs ADD CONSTRAINT reconciliation_runs_run_type_check
      CHECK (run_type IN (
        'wallet_ledger','money_columns','journal','projection','vouchers',
        'fees','commissions','refunds','settlement','provider_instructions',
        'suspense','loans','insurance','full'
      ));

    -- Money-integrity runs must never land as 'partial'.
    ALTER TABLE reconciliation_runs DROP CONSTRAINT IF EXISTS reconciliation_runs_state_check;
    ALTER TABLE reconciliation_runs ADD CONSTRAINT reconciliation_runs_state_check
      CHECK (state IN ('queued','running','passed','failed'));

    CREATE TABLE IF NOT EXISTS reconciliation_job_requests (
      id UUID PRIMARY KEY,
      run_type TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued'
        CHECK (state IN ('queued','claimed','completed','failed','cancelled')),
      requested_by TEXT NOT NULL,
      claimed_by TEXT,
      claimed_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      run_id UUID REFERENCES reconciliation_runs(id) ON DELETE SET NULL,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE INDEX IF NOT EXISTS reconciliation_job_requests_queue_idx
      ON reconciliation_job_requests(state, created_at)
      WHERE state = 'queued';

    CREATE TABLE IF NOT EXISTS on_call_alerts (
      id UUID PRIMARY KEY,
      severity TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low')),
      source TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
      state TEXT NOT NULL DEFAULT 'open'
        CHECK (state IN ('open','acknowledged','resolved')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      acknowledged_at TIMESTAMPTZ,
      resolved_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS on_call_alerts_open_idx
      ON on_call_alerts(severity, created_at)
      WHERE state = 'open';

    ALTER TABLE drift_remediation_proposals
      ADD COLUMN IF NOT EXISTS debit_account_id TEXT,
      ADD COLUMN IF NOT EXISTS credit_account_id TEXT,
      ADD COLUMN IF NOT EXISTS root_cause TEXT,
      ADD COLUMN IF NOT EXISTS approved_evidence_digest TEXT;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE drift_remediation_proposals
      DROP COLUMN IF EXISTS debit_account_id,
      DROP COLUMN IF EXISTS credit_account_id,
      DROP COLUMN IF EXISTS root_cause,
      DROP COLUMN IF EXISTS approved_evidence_digest;
    DROP TABLE IF EXISTS on_call_alerts;
    DROP TABLE IF EXISTS reconciliation_job_requests;
  `);
};
