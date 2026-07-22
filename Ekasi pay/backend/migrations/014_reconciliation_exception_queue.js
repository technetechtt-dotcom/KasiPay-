/**
 * Scheduled reconciliation runs and ops exception queue.
 */
export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS reconciliation_runs (
      id UUID PRIMARY KEY,
      run_type TEXT NOT NULL CHECK (run_type IN (
        'wallet_ledger','money_columns','journal','vouchers','settlement','commissions','full'
      )),
      state TEXT NOT NULL DEFAULT 'running'
        CHECK (state IN ('running','passed','failed','partial')),
      started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      completed_at TIMESTAMPTZ,
      report JSONB NOT NULL DEFAULT '{}'::jsonb,
      triggered_by TEXT NOT NULL DEFAULT 'scheduler'
    );
    CREATE INDEX IF NOT EXISTS reconciliation_runs_started_idx
      ON reconciliation_runs(started_at DESC);

    CREATE TABLE IF NOT EXISTS reconciliation_exceptions (
      id UUID PRIMARY KEY,
      run_id UUID REFERENCES reconciliation_runs(id) ON DELETE RESTRICT,
      exception_type TEXT NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('low','medium','high','critical')),
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
      state TEXT NOT NULL DEFAULT 'open'
        CHECK (state IN ('open','assigned','in_progress','resolved','accepted_risk','wont_fix')),
      assigned_operator_id TEXT REFERENCES ops_admin_users(id) ON DELETE SET NULL,
      resolution_note TEXT,
      resolution_evidence JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      resolved_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS reconciliation_exceptions_queue_idx
      ON reconciliation_exceptions(state, severity, created_at);
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS reconciliation_exceptions;
    DROP TABLE IF EXISTS reconciliation_runs;
  `);
};
