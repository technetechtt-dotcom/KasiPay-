export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS gross_total_cents BIGINT;
    UPDATE sales
       SET gross_total_cents = total_cents
     WHERE gross_total_cents IS NULL;
    ALTER TABLE sales ALTER COLUMN gross_total_cents SET DEFAULT 0;
    ALTER TABLE sales ALTER COLUMN gross_total_cents SET NOT NULL;

    ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_wallet_kind_check;
    ALTER TABLE wallets ADD CONSTRAINT wallets_wallet_kind_check
      CHECK (wallet_kind IN ('user', 'merchant_sales', 'merchant_float', 'system_escrow'));

    ALTER TABLE payout_agents DROP CONSTRAINT IF EXISTS payout_agents_status_check;
    ALTER TABLE payout_agents ADD CONSTRAINT payout_agents_status_check
      CHECK (status IN ('pending', 'enrolled', 'approved', 'suspended', 'rejected'));
    ALTER TABLE payout_agents
      ADD COLUMN IF NOT EXISTS per_transaction_limit_cents BIGINT NOT NULL DEFAULT 500000,
      ADD COLUMN IF NOT EXISTS daily_payout_limit_cents BIGINT NOT NULL DEFAULT 200000,
      ADD COLUMN IF NOT EXISTS daily_payout_used_cents BIGINT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS daily_payout_used_on DATE,
      ADD COLUMN IF NOT EXISTS float_suspended BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS reviewed_by TEXT,
      ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS reject_reason TEXT;

    UPDATE payout_agents
       SET daily_payout_limit_cents = daily_payout_cap_cents
     WHERE daily_payout_cap_cents IS NOT NULL
       AND daily_payout_limit_cents = 200000;

    CREATE TABLE IF NOT EXISTS payment_intents (
      id UUID PRIMARY KEY,
      product TEXT NOT NULL,
      rail TEXT NOT NULL,
      state TEXT NOT NULL,
      amount_cents BIGINT NOT NULL CHECK (amount_cents >= 0),
      currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
      pool_id TEXT NOT NULL,
      actor_user_id TEXT NOT NULL REFERENCES users(id),
      counterparty_user_id TEXT REFERENCES users(id),
      source_wallet_id TEXT REFERENCES wallets(id),
      destination_wallet_id TEXT REFERENCES wallets(id),
      financial_reference TEXT NOT NULL UNIQUE,
      idempotency_key TEXT,
      original_payment_id UUID REFERENCES payment_intents(id),
      journal_transaction_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS payment_intents_actor_idem_uidx
      ON payment_intents (actor_user_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS merchant_float_limits (
      merchant_user_id TEXT PRIMARY KEY REFERENCES users(id),
      float_floor_cents BIGINT NOT NULL DEFAULT 0,
      payout_limit_cents BIGINT NOT NULL DEFAULT 500000,
      daily_payout_limit_cents BIGINT NOT NULL DEFAULT 200000,
      suspended BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );

    CREATE TABLE IF NOT EXISTS merchant_float_topups (
      id UUID PRIMARY KEY,
      merchant_user_id TEXT NOT NULL REFERENCES users(id),
      merchant_id TEXT,
      amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
      currency TEXT NOT NULL DEFAULT 'ZAR',
      pool_id TEXT NOT NULL DEFAULT 'ZA',
      merchant_reference TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL DEFAULT 'requested'
        CHECK (state IN (
          'requested','awaiting_bank_match','matched','approved','credited','rejected','reversed'
        )),
      bank_transaction_id UUID,
      journal_transaction_id UUID,
      requested_by TEXT,
      approved_by TEXT,
      reject_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );

    CREATE TABLE IF NOT EXISTS merchant_float_withdrawals (
      id UUID PRIMARY KEY,
      merchant_user_id TEXT NOT NULL REFERENCES users(id),
      amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
      currency TEXT NOT NULL DEFAULT 'ZAR',
      pool_id TEXT NOT NULL DEFAULT 'ZA',
      state TEXT NOT NULL DEFAULT 'requested'
        CHECK (state IN (
          'requested','approved','submitted','unknown','fulfilled','failed','reconciled','reversed'
        )),
      settlement_account_id UUID,
      provider_instruction_id UUID,
      journal_transaction_id UUID,
      approval_request_id UUID,
      requested_by TEXT,
      approved_by TEXT,
      simulation BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );

    CREATE TABLE IF NOT EXISTS merchant_float_adjustments (
      id UUID PRIMARY KEY,
      merchant_user_id TEXT NOT NULL REFERENCES users(id),
      amount_cents BIGINT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'ZAR',
      reason TEXT NOT NULL,
      approval_request_id UUID,
      journal_transaction_id UUID,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );

    CREATE TABLE IF NOT EXISTS bank_transactions (
      id UUID PRIMARY KEY,
      bank_reference TEXT NOT NULL,
      merchant_reference TEXT,
      amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
      currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
      direction TEXT NOT NULL CHECK (direction IN ('credit','debit')),
      value_date DATE NOT NULL,
      source_account_fingerprint TEXT,
      destination_account TEXT,
      raw_hash TEXT NOT NULL UNIQUE,
      statement_file_id UUID,
      match_state TEXT NOT NULL DEFAULT 'unmatched'
        CHECK (match_state IN ('matched','partial','duplicate','unmatched','suspense')),
      matched_topup_id UUID REFERENCES merchant_float_topups(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE INDEX IF NOT EXISTS bank_transactions_merchant_ref_idx
      ON bank_transactions (merchant_reference, currency, amount_cents);

    CREATE TABLE IF NOT EXISTS bank_account_purposes (
      purpose TEXT PRIMARY KEY
        CHECK (purpose IN ('client_funds','operating','settlement','suspense'))
    );
    INSERT INTO bank_account_purposes (purpose) VALUES
      ('client_funds'), ('operating'), ('settlement'), ('suspense')
    ON CONFLICT DO NOTHING;

    CREATE TABLE IF NOT EXISTS bank_accounts (
      id UUID PRIMARY KEY,
      label TEXT NOT NULL,
      purpose TEXT NOT NULL REFERENCES bank_account_purposes(purpose),
      currency TEXT NOT NULL DEFAULT 'ZAR',
      pool_id TEXT NOT NULL DEFAULT 'ZA',
      account_fingerprint TEXT NOT NULL,
      external_ref TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE (purpose, currency, pool_id)
    );

    CREATE TABLE IF NOT EXISTS safeguarding_accounts (
      id UUID PRIMARY KEY,
      bank_account_id UUID NOT NULL REFERENCES bank_accounts(id),
      pool_id TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'ZAR',
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE (pool_id, currency)
    );

    CREATE TABLE IF NOT EXISTS safeguarding_reconciliations (
      id UUID PRIMARY KEY,
      pool_id TEXT NOT NULL,
      currency TEXT NOT NULL,
      expected_client_funds_cents BIGINT NOT NULL,
      actual_client_funds_cents BIGINT,
      difference_cents BIGINT,
      status TEXT NOT NULL
        CHECK (status IN ('balanced','shortfall','surplus','unknown')),
      report JSONB NOT NULL DEFAULT '{}'::jsonb,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );

    CREATE TABLE IF NOT EXISTS merchant_cash_availability (
      merchant_id TEXT PRIMARY KEY REFERENCES merchants(id),
      availability_band TEXT NOT NULL
        CHECK (availability_band IN (
          'unavailable','under_500','500_to_1000','1000_to_2000','2000_to_5000','over_5000'
        )),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );

    CREATE TABLE IF NOT EXISTS merchant_settlement_positions (
      id UUID PRIMARY KEY,
      merchant_user_id TEXT NOT NULL REFERENCES users(id),
      pool_id TEXT NOT NULL,
      currency TEXT NOT NULL,
      position_date DATE NOT NULL,
      opening_cents BIGINT NOT NULL DEFAULT 0,
      cash_in_cents BIGINT NOT NULL DEFAULT 0,
      cash_out_cents BIGINT NOT NULL DEFAULT 0,
      wallet_inflow_cents BIGINT NOT NULL DEFAULT 0,
      wallet_outflow_cents BIGINT NOT NULL DEFAULT 0,
      commission_cents BIGINT NOT NULL DEFAULT 0,
      fees_cents BIGINT NOT NULL DEFAULT 0,
      adjustments_cents BIGINT NOT NULL DEFAULT 0,
      net_position_cents BIGINT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open','batched','submitted','settled','held')),
      UNIQUE (merchant_user_id, pool_id, currency, position_date)
    );

    CREATE TABLE IF NOT EXISTS settlement_batch_items (
      id UUID PRIMARY KEY,
      batch_id UUID NOT NULL REFERENCES settlement_batches(id),
      position_id UUID NOT NULL REFERENCES merchant_settlement_positions(id),
      net_cents BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE (batch_id, position_id)
    );

    CREATE TABLE IF NOT EXISTS fee_lifecycle_events (
      id UUID PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      component TEXT NOT NULL,
      amount_cents BIGINT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('accrued','earned','reversed','swept')),
      journal_transaction_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE INDEX IF NOT EXISTS fee_lifecycle_source_idx
      ON fee_lifecycle_events (source_type, source_id);

    UPDATE fee_schedules
       SET state = 'retired', effective_to = NOW()
     WHERE code = 'CASH_SEND_STANDARD' AND version = 2 AND state = 'published';

    INSERT INTO fee_schedules
      (id,code,version,currency,product,effective_from,state)
    VALUES
      ('60000000-0000-4000-8000-000000000005','CASH_SEND_STANDARD',3,'ZAR',
       'cash_send', NOW(), 'published')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO fee_schedule_tiers
      (id,fee_schedule_id,min_cents,max_cents,flat_cents,rate_basis_points,
       min_fee_cents,max_fee_cents,allocations)
    VALUES
      ('60000000-0000-4000-8000-000000000006',
       '60000000-0000-4000-8000-000000000005',0,NULL,900,0,900,900,
       '{"agent":2223,"merchant":1112,"platform":6665}'::jsonb)
    ON CONFLICT (id) DO NOTHING;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DELETE FROM fee_schedule_tiers WHERE id = '60000000-0000-4000-8000-000000000006';
    DELETE FROM fee_schedules WHERE id = '60000000-0000-4000-8000-000000000005';
    UPDATE fee_schedules
       SET state = 'published', effective_to = NULL
     WHERE code = 'CASH_SEND_STANDARD' AND version = 2;

    DROP TABLE IF EXISTS fee_lifecycle_events;
    DROP TABLE IF EXISTS settlement_batch_items;
    DROP TABLE IF EXISTS merchant_settlement_positions;
    DROP TABLE IF EXISTS merchant_cash_availability;
    DROP TABLE IF EXISTS safeguarding_reconciliations;
    DROP TABLE IF EXISTS safeguarding_accounts;
    DROP TABLE IF EXISTS bank_accounts;
    DROP TABLE IF EXISTS bank_account_purposes;
    DROP TABLE IF EXISTS bank_transactions;
    DROP TABLE IF EXISTS merchant_float_adjustments;
    DROP TABLE IF EXISTS merchant_float_withdrawals;
    DROP TABLE IF EXISTS merchant_float_topups;
    DROP TABLE IF EXISTS merchant_float_limits;
    DROP TABLE IF EXISTS payment_intents;
    ALTER TABLE sales DROP COLUMN IF EXISTS gross_total_cents;
  `);
};
