/**
 * Phase 6: settlement, fee policy, compensating refunds and provider journals.
 *
 * Provider/bank-specific mappings remain configuration and certification work.
 * This migration only installs vendor-neutral, append-only control primitives.
 */
export const up = (pgm) => {
  pgm.sql(String.raw`
    ALTER TABLE approval_requests DROP CONSTRAINT approval_requests_action_type_check;
    ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_action_type_check
      CHECK (action_type IN (
        'loan_disbursement','balance_adjustment','merchant_approval_override',
        'refund_reversal','user_role_change','transaction_limit_change',
        'settlement_resolution','daily_close','fee_schedule_publish'
      ));

    CREATE TABLE merchant_settlement_accounts (
      id UUID PRIMARY KEY,
      merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
      currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
      provider TEXT NOT NULL,
      account_token TEXT NOT NULL,
      account_fingerprint TEXT NOT NULL,
      beneficiary_name TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending','verified','suspended','closed')),
      created_by TEXT REFERENCES ops_admin_users(id) ON DELETE RESTRICT,
      verified_at TIMESTAMPTZ,
      verified_by TEXT REFERENCES ops_admin_users(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE(provider, account_fingerprint)
    );

    CREATE TABLE settlement_batches (
      id UUID PRIMARY KEY,
      batch_reference TEXT NOT NULL UNIQUE,
      currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
      provider TEXT NOT NULL,
      settlement_date DATE NOT NULL,
      state TEXT NOT NULL DEFAULT 'created'
        CHECK (state IN ('created','approved','submitted','accepted','partially_settled',
                         'settled','failed','cancelled')),
      item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
      total_cents BIGINT NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
      maker_operator_id TEXT REFERENCES ops_admin_users(id) ON DELETE RESTRICT,
      checker_operator_id TEXT REFERENCES ops_admin_users(id) ON DELETE RESTRICT,
      approval_request_id UUID REFERENCES approval_requests(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      approved_at TIMESTAMPTZ,
      closed_at TIMESTAMPTZ,
      CHECK (maker_operator_id IS NULL OR checker_operator_id IS NULL
             OR maker_operator_id <> checker_operator_id)
    );

    CREATE TABLE payout_instructions (
      id UUID PRIMARY KEY,
      batch_id UUID NOT NULL REFERENCES settlement_batches(id) ON DELETE RESTRICT,
      settlement_account_id UUID NOT NULL REFERENCES merchant_settlement_accounts(id) ON DELETE RESTRICT,
      journal_transaction_id UUID NOT NULL REFERENCES journal_transactions(id) ON DELETE RESTRICT,
      amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
      currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
      state TEXT NOT NULL DEFAULT 'created'
        CHECK (state IN ('created','submitted','accepted','fulfilled','failed','unknown','reversed')),
      provider_reference TEXT,
      provider_instruction_id UUID,
      failure_code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE(batch_id, journal_transaction_id)
    );

    CREATE TABLE settlement_statement_files (
      id UUID PRIMARY KEY,
      provider TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      file_name TEXT NOT NULL,
      content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
      canonical_sha256 TEXT NOT NULL CHECK (canonical_sha256 ~ '^[0-9a-f]{64}$'),
      row_count INTEGER NOT NULL CHECK (row_count >= 0),
      imported_by TEXT NOT NULL REFERENCES ops_admin_users(id) ON DELETE RESTRICT,
      imported_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE(provider, content_sha256),
      UNIQUE(provider, canonical_sha256)
    );

    CREATE TABLE settlement_statement_items (
      id UUID PRIMARY KEY,
      statement_file_id UUID NOT NULL REFERENCES settlement_statement_files(id) ON DELETE RESTRICT,
      row_number INTEGER NOT NULL CHECK (row_number > 0),
      provider_reference TEXT NOT NULL,
      bank_reference TEXT,
      amount_cents BIGINT NOT NULL,
      currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
      value_date DATE NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('credit','debit')),
      row_sha256 TEXT NOT NULL CHECK (row_sha256 ~ '^[0-9a-f]{64}$'),
      raw_safe JSONB NOT NULL,
      match_state TEXT NOT NULL DEFAULT 'unmatched'
        CHECK (match_state IN ('matched','unmatched','partial','duplicate','suspense','resolved')),
      journal_transaction_id UUID REFERENCES journal_transactions(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE(statement_file_id, row_number),
      UNIQUE(statement_file_id, row_sha256)
    );
    CREATE INDEX settlement_items_match_idx
      ON settlement_statement_items(provider_reference, amount_cents, currency, value_date);

    CREATE TABLE settlement_matches (
      id UUID PRIMARY KEY,
      statement_item_id UUID NOT NULL REFERENCES settlement_statement_items(id) ON DELETE RESTRICT,
      payout_instruction_id UUID REFERENCES payout_instructions(id) ON DELETE RESTRICT,
      journal_transaction_id UUID NOT NULL REFERENCES journal_transactions(id) ON DELETE RESTRICT,
      matched_cents BIGINT NOT NULL CHECK (matched_cents > 0),
      match_rule TEXT NOT NULL,
      confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE(statement_item_id, journal_transaction_id)
    );

    CREATE TABLE settlement_suspense_cases (
      id UUID PRIMARY KEY,
      statement_item_id UUID NOT NULL UNIQUE REFERENCES settlement_statement_items(id) ON DELETE RESTRICT,
      suspense_journal_transaction_id UUID NOT NULL REFERENCES journal_transactions(id) ON DELETE RESTRICT,
      state TEXT NOT NULL DEFAULT 'open'
        CHECK (state IN ('open','pending_approval','approved','resolved','rejected')),
      reason_code TEXT NOT NULL,
      proposed_journal_transaction_id UUID REFERENCES journal_transactions(id) ON DELETE RESTRICT,
      approval_request_id UUID REFERENCES approval_requests(id) ON DELETE RESTRICT,
      maker_operator_id TEXT REFERENCES ops_admin_users(id) ON DELETE RESTRICT,
      checker_operator_id TEXT REFERENCES ops_admin_users(id) ON DELETE RESTRICT,
      opened_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      resolved_at TIMESTAMPTZ,
      CHECK (maker_operator_id IS NULL OR checker_operator_id IS NULL
             OR maker_operator_id <> checker_operator_id)
    );
    CREATE TABLE settlement_suspense_events (
      id UUID PRIMARY KEY,
      case_id UUID NOT NULL REFERENCES settlement_suspense_cases(id) ON DELETE RESTRICT,
      from_state TEXT,
      to_state TEXT NOT NULL,
      actor_operator_id TEXT REFERENCES ops_admin_users(id) ON DELETE RESTRICT,
      reason TEXT NOT NULL,
      evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );

    CREATE TABLE settlement_daily_closes (
      id UUID PRIMARY KEY,
      close_date DATE NOT NULL,
      currency TEXT NOT NULL,
      provider TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'draft'
        CHECK (state IN ('draft','pending_approval','signed_off','reopened')),
      expected_cents BIGINT NOT NULL,
      statement_cents BIGINT NOT NULL,
      matched_cents BIGINT NOT NULL,
      break_cents BIGINT NOT NULL,
      evidence JSONB NOT NULL,
      evidence_sha256 TEXT NOT NULL,
      maker_operator_id TEXT NOT NULL REFERENCES ops_admin_users(id) ON DELETE RESTRICT,
      checker_operator_id TEXT REFERENCES ops_admin_users(id) ON DELETE RESTRICT,
      approval_request_id UUID REFERENCES approval_requests(id) ON DELETE RESTRICT,
      signed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE(close_date, currency, provider),
      CHECK (checker_operator_id IS NULL OR checker_operator_id <> maker_operator_id)
    );
    CREATE TABLE settlement_alerts (
      id UUID PRIMARY KEY,
      alert_type TEXT NOT NULL CHECK (alert_type IN
        ('unmatched','partial','duplicate','late_payout','daily_close_break','provider_unknown')),
      severity TEXT NOT NULL CHECK (severity IN ('warning','high','critical')),
      statement_item_id UUID REFERENCES settlement_statement_items(id) ON DELETE RESTRICT,
      financial_reference TEXT,
      safe_details JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );

    CREATE TABLE fee_schedules (
      id UUID PRIMARY KEY,
      code TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
      product TEXT NOT NULL,
      effective_from TIMESTAMPTZ NOT NULL,
      effective_to TIMESTAMPTZ,
      state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','published','retired')),
      maker_operator_id TEXT REFERENCES ops_admin_users(id) ON DELETE RESTRICT,
      checker_operator_id TEXT REFERENCES ops_admin_users(id) ON DELETE RESTRICT,
      approval_request_id UUID REFERENCES approval_requests(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE(code, version),
      CHECK (effective_to IS NULL OR effective_to > effective_from),
      CHECK (maker_operator_id IS NULL OR checker_operator_id IS NULL
             OR maker_operator_id <> checker_operator_id)
    );
    CREATE UNIQUE INDEX fee_schedule_published_effective_idx
      ON fee_schedules(code, effective_from) WHERE state = 'published';

    CREATE TABLE fee_schedule_tiers (
      id UUID PRIMARY KEY,
      fee_schedule_id UUID NOT NULL REFERENCES fee_schedules(id) ON DELETE RESTRICT,
      min_cents BIGINT NOT NULL CHECK (min_cents >= 0),
      max_cents BIGINT CHECK (max_cents IS NULL OR max_cents >= min_cents),
      flat_cents BIGINT NOT NULL DEFAULT 0 CHECK (flat_cents >= 0),
      rate_basis_points INTEGER NOT NULL DEFAULT 0 CHECK (rate_basis_points BETWEEN 0 AND 10000),
      min_fee_cents BIGINT NOT NULL DEFAULT 0 CHECK (min_fee_cents >= 0),
      max_fee_cents BIGINT,
      allocations JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE(fee_schedule_id, min_cents),
      CHECK (max_fee_cents IS NULL OR max_fee_cents >= min_fee_cents)
    );

    CREATE TABLE fee_assessments (
      id UUID PRIMARY KEY,
      fee_schedule_id UUID NOT NULL REFERENCES fee_schedules(id) ON DELETE RESTRICT,
      fee_tier_id UUID NOT NULL REFERENCES fee_schedule_tiers(id) ON DELETE RESTRICT,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      principal_cents BIGINT NOT NULL CHECK (principal_cents > 0),
      total_fee_cents BIGINT NOT NULL CHECK (total_fee_cents >= 0),
      currency TEXT NOT NULL,
      journal_transaction_id UUID NOT NULL REFERENCES journal_transactions(id) ON DELETE RESTRICT,
      calculation JSONB NOT NULL,
      reversal_of_id UUID REFERENCES fee_assessments(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE(source_type, source_id),
      UNIQUE(reversal_of_id),
      CHECK (reversal_of_id IS NULL OR total_fee_cents = 0)
    );
    CREATE TABLE fee_assessment_components (
      id UUID PRIMARY KEY,
      assessment_id UUID NOT NULL REFERENCES fee_assessments(id) ON DELETE RESTRICT,
      component TEXT NOT NULL CHECK (component IN ('platform','provider','tax','agent','merchant')),
      amount_cents BIGINT NOT NULL CHECK (amount_cents >= 0),
      liability_account_id TEXT NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
      beneficiary_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
      settlement_journal_transaction_id UUID REFERENCES journal_transactions(id) ON DELETE RESTRICT,
      UNIQUE(assessment_id, component),
      CHECK (component <> 'agent' OR beneficiary_user_id IS NOT NULL)
    );
    ALTER TABLE payout_instructions
      ADD COLUMN source_fee_component_id UUID UNIQUE
        REFERENCES fee_assessment_components(id) ON DELETE RESTRICT;

    INSERT INTO fee_schedules
      (id,code,version,currency,product,effective_from,state)
    VALUES
      ('60000000-0000-4000-8000-000000000001','CASH_SEND_STANDARD',1,'ZAR',
       'cash_send','2020-01-01T00:00:00Z','published');
    INSERT INTO fee_schedule_tiers
      (id,fee_schedule_id,min_cents,max_cents,flat_cents,rate_basis_points,
       min_fee_cents,max_fee_cents,allocations)
    VALUES
      ('60000000-0000-4000-8000-000000000002',
       '60000000-0000-4000-8000-000000000001',0,NULL,1000,0,1000,1000,
       '{"agent":5000,"platform":5000}'::jsonb);

    CREATE TABLE refund_requests (
      id UUID PRIMARY KEY,
      original_journal_transaction_id UUID NOT NULL REFERENCES journal_transactions(id) ON DELETE RESTRICT,
      compensating_journal_transaction_id UUID UNIQUE REFERENCES journal_transactions(id) ON DELETE RESTRICT,
      product TEXT NOT NULL CHECK (product IN
        ('wallet_sale','transfer','utility','cash_send','loan','commission','insurance')),
      requested_cents BIGINT NOT NULL CHECK (requested_cents > 0),
      refundable_ceiling_cents BIGINT NOT NULL CHECK (refundable_ceiling_cents >= 0),
      currency TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'requested'
        CHECK (state IN ('requested','pending_approval','approved','posted','rejected','failed')),
      reason TEXT NOT NULL,
      stock_compensation JSONB,
      domain_compensation JSONB,
      approval_request_id UUID REFERENCES approval_requests(id) ON DELETE RESTRICT,
      idempotency_key TEXT NOT NULL,
      requested_by_type TEXT NOT NULL CHECK (requested_by_type IN ('user','operator','system')),
      requested_by_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      posted_at TIMESTAMPTZ,
      UNIQUE(requested_by_type, requested_by_id, idempotency_key),
      CHECK (requested_cents <= refundable_ceiling_cents)
    );

    CREATE TABLE provider_endpoints (
      id UUID PRIMARY KEY,
      provider TEXT NOT NULL,
      product TEXT NOT NULL,
      environment TEXT NOT NULL CHECK (environment IN ('sandbox','production')),
      base_url TEXT NOT NULL,
      signing_key_ref TEXT NOT NULL,
      timeout_ms INTEGER NOT NULL CHECK (timeout_ms BETWEEN 100 AND 120000),
      max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 20),
      circuit_failure_threshold INTEGER NOT NULL CHECK (circuit_failure_threshold BETWEEN 1 AND 100),
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      UNIQUE(provider, product, environment)
    );

    CREATE TABLE provider_instructions (
      id UUID PRIMARY KEY,
      endpoint_id UUID NOT NULL REFERENCES provider_endpoints(id) ON DELETE RESTRICT,
      instruction_type TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      financial_reference TEXT NOT NULL,
      journal_transaction_id UUID REFERENCES journal_transactions(id) ON DELETE RESTRICT,
      state TEXT NOT NULL DEFAULT 'created'
        CHECK (state IN ('created','submitted','accepted','fulfilled','failed','unknown','reversed')),
      request_payload JSONB NOT NULL,
      request_sha256 TEXT NOT NULL,
      response_sha256 TEXT,
      provider_reference TEXT,
      token_fingerprint TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      unknown_since TIMESTAMPTZ,
      fulfilled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE(endpoint_id, idempotency_key),
      UNIQUE(endpoint_id, provider_reference)
    );
    CREATE INDEX provider_instruction_dispatch_idx
      ON provider_instructions(state, next_attempt_at)
      WHERE state IN ('created','failed','unknown');

    CREATE TABLE provider_attempts (
      id UUID PRIMARY KEY,
      instruction_id UUID NOT NULL REFERENCES provider_instructions(id) ON DELETE RESTRICT,
      attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
      request_sha256 TEXT NOT NULL,
      response_sha256 TEXT,
      http_status INTEGER,
      outcome TEXT NOT NULL CHECK (outcome IN
        ('submitted','accepted','fulfilled','failed','timeout','unknown','requery')),
      error_code TEXT,
      latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE(instruction_id, attempt_number)
    );

    CREATE TABLE provider_callback_inbox (
      id UUID PRIMARY KEY,
      endpoint_id UUID NOT NULL REFERENCES provider_endpoints(id) ON DELETE RESTRICT,
      provider_event_id TEXT NOT NULL,
      provider_reference TEXT,
      received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      provider_timestamp TIMESTAMPTZ NOT NULL,
      signature TEXT NOT NULL,
      payload JSONB NOT NULL,
      payload_sha256 TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'received'
        CHECK (state IN ('received','processed','rejected','duplicate')),
      rejection_reason TEXT,
      processed_at TIMESTAMPTZ,
      UNIQUE(endpoint_id, provider_event_id),
      UNIQUE(endpoint_id, payload_sha256)
    );

    CREATE TABLE provider_dead_letters (
      id UUID PRIMARY KEY,
      instruction_id UUID NOT NULL UNIQUE REFERENCES provider_instructions(id) ON DELETE RESTRICT,
      final_error TEXT NOT NULL,
      evidence JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      resolved_at TIMESTAMPTZ,
      resolved_by TEXT REFERENCES ops_admin_users(id) ON DELETE RESTRICT
    );

    CREATE TABLE provider_circuit_state (
      endpoint_id UUID PRIMARY KEY REFERENCES provider_endpoints(id) ON DELETE RESTRICT,
      state TEXT NOT NULL CHECK (state IN ('closed','open','half_open')),
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      opened_at TIMESTAMPTZ,
      retry_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );

    INSERT INTO provider_endpoints
      (id,provider,product,environment,base_url,signing_key_ref,timeout_ms,
       max_attempts,circuit_failure_threshold,enabled)
    VALUES
      ('60000000-0000-4000-8000-000000000003','simulator','utility','sandbox',
       'simulator://utility','env:UTILITY_VENDOR_API_KEY',5000,5,3,TRUE);
    INSERT INTO provider_circuit_state(endpoint_id,state)
    VALUES ('60000000-0000-4000-8000-000000000003','closed');

    ALTER TABLE utility_purchases
      ADD COLUMN provider_instruction_id UUID REFERENCES provider_instructions(id) ON DELETE RESTRICT,
      ADD COLUMN journal_transaction_id UUID REFERENCES journal_transactions(id) ON DELETE RESTRICT,
      ADD COLUMN provider_reference TEXT,
      ADD COLUMN failure_reason TEXT;

    ALTER TABLE commission_postings
      ADD COLUMN fee_assessment_id UUID REFERENCES fee_assessments(id) ON DELETE RESTRICT,
      ADD COLUMN journal_transaction_id UUID REFERENCES journal_transactions(id) ON DELETE RESTRICT;

    ALTER TABLE payout_instructions
      ADD CONSTRAINT payout_provider_instruction_fk
      FOREIGN KEY (provider_instruction_id) REFERENCES provider_instructions(id) ON DELETE RESTRICT;

    INSERT INTO ledger_accounts
      (id, code, name, account_class, normal_side, currency, pool_id, allow_negative)
    VALUES
      ('phase6-platform-liability-zar','P6-PLATFORM-ZAR','Platform fee liability','liability','credit','ZAR','ZA',TRUE),
      ('phase6-provider-liability-zar','P6-PROVIDER-ZAR','Provider fee liability','liability','credit','ZAR','ZA',TRUE),
      ('phase6-tax-liability-zar','P6-TAX-ZAR','Tax liability','liability','credit','ZAR','ZA',TRUE),
      ('phase6-agent-liability-zar','P6-AGENT-ZAR','Agent commission liability','liability','credit','ZAR','ZA',TRUE),
      ('phase6-merchant-liability-zar','P6-MERCHANT-ZAR','Merchant settlement liability','liability','credit','ZAR','ZA',TRUE),
      ('phase6-settlement-suspense-zar','P6-SUSPENSE-ZAR','Settlement suspense','asset','debit','ZAR','ZA',TRUE)
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO account_balance_projections(account_id)
      SELECT id FROM ledger_accounts WHERE id LIKE 'phase6-%'
      ON CONFLICT (account_id) DO NOTHING;

    CREATE TRIGGER settlement_statement_files_immutable
      BEFORE UPDATE OR DELETE ON settlement_statement_files
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
    CREATE TRIGGER settlement_matches_immutable
      BEFORE UPDATE OR DELETE ON settlement_matches
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
    CREATE TRIGGER settlement_suspense_events_immutable
      BEFORE UPDATE OR DELETE ON settlement_suspense_events
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
    CREATE TRIGGER settlement_alerts_immutable
      BEFORE UPDATE OR DELETE ON settlement_alerts
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
    CREATE TRIGGER provider_attempts_immutable
      BEFORE UPDATE OR DELETE ON provider_attempts
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
    CREATE TRIGGER fee_assessments_immutable
      BEFORE UPDATE OR DELETE ON fee_assessments
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
    CREATE TRIGGER fee_components_immutable
      BEFORE UPDATE OR DELETE ON fee_assessment_components
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
  `);
};

export const down = false;
