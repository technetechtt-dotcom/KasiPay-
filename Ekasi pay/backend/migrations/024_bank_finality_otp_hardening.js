/**
 * Bank transaction finality, OTP brute-force controls, cash adjustments,
 * safeguarding sign-off, and dual-control float adjustments.
 */
export const up = (pgm) => {
  pgm.sql(`
    UPDATE cash_send_payout_otps a
       SET consumed_at = clock_timestamp()
     WHERE consumed_at IS NULL
       AND EXISTS (
         SELECT 1 FROM cash_send_payout_otps b
          WHERE b.voucher_id = a.voucher_id
            AND b.consumed_at IS NULL
            AND b.created_at > a.created_at
       );

    ALTER TABLE bank_transactions
      ADD COLUMN IF NOT EXISTS lifecycle_status TEXT NOT NULL DEFAULT 'received',
      ADD COLUMN IF NOT EXISTS settlement_date DATE,
      ADD COLUMN IF NOT EXISTS reversal_of_id UUID REFERENCES bank_transactions(id),
      ADD COLUMN IF NOT EXISTS provider_event_id TEXT,
      ADD COLUMN IF NOT EXISTS posted_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS reconciliation_status TEXT NOT NULL DEFAULT 'open';
    ALTER TABLE bank_transactions DROP CONSTRAINT IF EXISTS bank_transactions_lifecycle_status_check;
    ALTER TABLE bank_transactions ADD CONSTRAINT bank_transactions_lifecycle_status_check
      CHECK (lifecycle_status IN ('received','pending','posted','settled','reversed','rejected'));
    ALTER TABLE bank_transactions DROP CONSTRAINT IF EXISTS bank_transactions_recon_status_check;
    ALTER TABLE bank_transactions ADD CONSTRAINT bank_transactions_recon_status_check
      CHECK (reconciliation_status IN ('open','matched','investigating','closed'));
    CREATE UNIQUE INDEX IF NOT EXISTS bank_transactions_provider_event_uidx
      ON bank_transactions (provider_event_id)
      WHERE provider_event_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS bank_transaction_events (
      id UUID PRIMARY KEY,
      bank_transaction_id UUID NOT NULL REFERENCES bank_transactions(id),
      from_status TEXT,
      to_status TEXT NOT NULL,
      actor_id TEXT,
      reason TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE INDEX IF NOT EXISTS bank_transaction_events_tx_idx
      ON bank_transaction_events (bank_transaction_id, created_at);

    CREATE TABLE IF NOT EXISTS bank_account_balances (
      id UUID PRIMARY KEY,
      bank_account_id UUID NOT NULL REFERENCES bank_accounts(id),
      as_of DATE NOT NULL,
      available_cents BIGINT NOT NULL,
      source TEXT NOT NULL,
      imported_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE (bank_account_id, as_of, source)
    );

    ALTER TABLE cash_send_payout_otps
      ADD COLUMN IF NOT EXISTS failed_attempts INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS send_count INTEGER NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS last_sent_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
    CREATE UNIQUE INDEX IF NOT EXISTS cash_send_payout_otps_one_active_uidx
      ON cash_send_payout_otps (voucher_id)
      WHERE consumed_at IS NULL;

    CREATE TABLE IF NOT EXISTS merchant_cash_adjustments (
      id UUID PRIMARY KEY,
      merchant_id TEXT NOT NULL REFERENCES merchants(id),
      actor_user_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      previous_available_cents BIGINT NOT NULL,
      next_available_cents BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );

    ALTER TABLE merchant_cash_liquidity
      ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp();

    CREATE TABLE IF NOT EXISTS safeguarding_signoffs (
      id UUID PRIMARY KEY,
      report_id UUID NOT NULL REFERENCES safeguarding_reconciliations(id),
      operator_id TEXT NOT NULL,
      note TEXT,
      signed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );

    CREATE TABLE IF NOT EXISTS merchant_float_debts (
      id UUID PRIMARY KEY,
      merchant_user_id TEXT NOT NULL REFERENCES users(id),
      bank_transaction_id UUID REFERENCES bank_transactions(id),
      amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
      recovered_cents BIGINT NOT NULL DEFAULT 0 CHECK (recovered_cents >= 0),
      state TEXT NOT NULL DEFAULT 'open'
        CHECK (state IN ('open','frozen','investigating','recovered','written_off')),
      reason TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );

    ALTER TABLE merchant_float_limits
      ADD COLUMN IF NOT EXISTS daily_cash_in_limit_cents BIGINT NOT NULL DEFAULT 200000,
      ADD COLUMN IF NOT EXISTS monthly_cash_in_limit_cents BIGINT NOT NULL DEFAULT 2000000,
      ADD COLUMN IF NOT EXISTS cash_out_limit_cents BIGINT NOT NULL DEFAULT 500000,
      ADD COLUMN IF NOT EXISTS exposure_limit_cents BIGINT NOT NULL DEFAULT 1000000,
      ADD COLUMN IF NOT EXISTS risk_tier TEXT NOT NULL DEFAULT 'standard';

    ALTER TABLE reconciliation_worker_heartbeats
      ADD COLUMN IF NOT EXISTS last_ok_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS last_error TEXT,
      ADD COLUMN IF NOT EXISTS drift_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS worker_version TEXT;

    ALTER TABLE approval_requests DROP CONSTRAINT IF EXISTS approval_requests_action_type_check;
    ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_action_type_check
      CHECK (action_type IN (
        'loan_disbursement','loan_write_off','balance_adjustment',
        'merchant_approval_override','refund_reversal','user_role_change',
        'transaction_limit_change','settlement_resolution','daily_close',
        'fee_schedule_publish','insurance_claim_payout','posting_control_enable',
        'merchant_activation_waiver','float_adjustment'
      ));
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE approval_requests DROP CONSTRAINT IF EXISTS approval_requests_action_type_check;
    ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_action_type_check
      CHECK (action_type IN (
        'loan_disbursement','loan_write_off','balance_adjustment',
        'merchant_approval_override','refund_reversal','user_role_change',
        'transaction_limit_change','settlement_resolution','daily_close',
        'fee_schedule_publish','insurance_claim_payout','posting_control_enable',
        'merchant_activation_waiver'
      ));
    ALTER TABLE reconciliation_worker_heartbeats
      DROP COLUMN IF EXISTS worker_version,
      DROP COLUMN IF EXISTS drift_count,
      DROP COLUMN IF EXISTS last_error,
      DROP COLUMN IF EXISTS last_ok_at;
    DROP TABLE IF EXISTS merchant_float_debts;
    DROP TABLE IF EXISTS safeguarding_signoffs;
    DROP TABLE IF EXISTS merchant_cash_adjustments;
    DROP INDEX IF EXISTS cash_send_payout_otps_one_active_uidx;
    DROP TABLE IF EXISTS bank_account_balances;
    DROP TABLE IF EXISTS bank_transaction_events;
    DROP INDEX IF EXISTS bank_transactions_provider_event_uidx;
    ALTER TABLE bank_transactions
      DROP CONSTRAINT IF EXISTS bank_transactions_recon_status_check,
      DROP CONSTRAINT IF EXISTS bank_transactions_lifecycle_status_check,
      DROP COLUMN IF EXISTS reconciliation_status,
      DROP COLUMN IF EXISTS reversed_at,
      DROP COLUMN IF EXISTS settled_at,
      DROP COLUMN IF EXISTS posted_at,
      DROP COLUMN IF EXISTS provider_event_id,
      DROP COLUMN IF EXISTS reversal_of_id,
      DROP COLUMN IF EXISTS settlement_date,
      DROP COLUMN IF EXISTS lifecycle_status;
  `);
};
