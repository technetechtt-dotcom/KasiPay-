/**
 * Reconciliation job leases + immutable drift remediation proposals.
 */
export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS reconciliation_job_leases (
      job_key TEXT PRIMARY KEY,
      lease_owner TEXT NOT NULL,
      lease_token UUID NOT NULL,
      leased_until TIMESTAMPTZ NOT NULL,
      last_started_at TIMESTAMPTZ,
      last_completed_at TIMESTAMPTZ,
      last_status TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );

    ALTER TABLE reconciliation_runs
      ADD COLUMN IF NOT EXISTS lease_token UUID,
      ADD COLUMN IF NOT EXISTS attempt INTEGER NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS error_message TEXT;

    ALTER TABLE reconciliation_runs DROP CONSTRAINT IF EXISTS reconciliation_runs_run_type_check;
    ALTER TABLE reconciliation_runs ADD CONSTRAINT reconciliation_runs_run_type_check
      CHECK (run_type IN (
        'wallet_ledger','money_columns','journal','projection','vouchers',
        'fees','commissions','refunds','settlement','suspense','full'
      ));

    CREATE TABLE IF NOT EXISTS drift_remediation_proposals (
      id UUID PRIMARY KEY,
      wallet_id TEXT NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
      currency TEXT NOT NULL,
      pool_id TEXT NOT NULL DEFAULT 'ZA',
      wallet_balance_cents BIGINT NOT NULL,
      legacy_ledger_cents BIGINT NOT NULL,
      projection_cents BIGINT,
      journal_derived_cents BIGINT,
      delta_cents BIGINT NOT NULL,
      authoritative_side TEXT NOT NULL CHECK (authoritative_side IN ('wallet','ledger','manual')),
      origin TEXT NOT NULL,
      evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
      evidence_digest TEXT NOT NULL,
      expected_post_wallet_cents BIGINT NOT NULL,
      expected_post_ledger_cents BIGINT NOT NULL,
      state TEXT NOT NULL DEFAULT 'proposed'
        CHECK (state IN ('proposed','approved','executed','rejected','superseded')),
      approval_request_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      created_by TEXT NOT NULL,
      decided_at TIMESTAMPTZ,
      executed_at TIMESTAMPTZ,
      execution_reference TEXT,
      report_hash TEXT
    );
    CREATE INDEX IF NOT EXISTS drift_remediation_proposals_wallet_idx
      ON drift_remediation_proposals(wallet_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS drift_remediation_open_wallet_uidx
      ON drift_remediation_proposals(wallet_id)
      WHERE state IN ('proposed','approved');
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS drift_remediation_proposals;
    DROP TABLE IF EXISTS reconciliation_job_leases;
    ALTER TABLE reconciliation_runs
      DROP COLUMN IF EXISTS lease_token,
      DROP COLUMN IF EXISTS attempt,
      DROP COLUMN IF EXISTS error_message;
  `);
};
