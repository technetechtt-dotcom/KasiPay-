/**
 * Phase 5: fraud controls, hardened vouchers, operational resilience and
 * durable audit/observability evidence.
 *
 * This migration installs control-plane primitives only. It does not configure
 * a sanctions provider, monitoring sink, alert route, or backup provider.
 */
export const up = (pgm) => {
  pgm.sql(String.raw`
    CREATE TABLE risk_tier_limits (
      kyc_tier TEXT NOT NULL,
      transaction_type TEXT NOT NULL,
      per_transaction_cents BIGINT NOT NULL CHECK (per_transaction_cents > 0),
      daily_cents BIGINT NOT NULL CHECK (daily_cents > 0),
      monthly_cents BIGINT NOT NULL CHECK (monthly_cents > 0),
      daily_count INTEGER NOT NULL CHECK (daily_count > 0),
      monthly_count INTEGER NOT NULL CHECK (monthly_count > 0),
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_by TEXT,
      PRIMARY KEY (kyc_tier, transaction_type)
    );

    CREATE TABLE risk_rules (
      id UUID PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      event_type TEXT NOT NULL,
      expression JSONB NOT NULL,
      score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 1000),
      action TEXT NOT NULL CHECK (action IN ('allow','review','hold','block')),
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );

    INSERT INTO risk_tier_limits(
      kyc_tier, transaction_type, per_transaction_cents, daily_cents, monthly_cents,
      daily_count, monthly_count, updated_by
    ) VALUES
      ('Basic','transfer',500000,1000000,5000000,10,100,'migration'),
      ('Basic','voucher',300000,500000,2000000,5,30,'migration'),
      ('Basic','cash_out',300000,500000,2000000,5,30,'migration'),
      ('Standard','transfer',2000000,5000000,30000000,30,300,'migration'),
      ('Standard','voucher',1000000,3000000,15000000,15,100,'migration'),
      ('Standard','cash_out',1000000,3000000,15000000,15,100,'migration'),
      ('Premium','transfer',5000000,15000000,100000000,50,500,'migration'),
      ('Premium','voucher',2000000,5000000,30000000,25,200,'migration'),
      ('Premium','cash_out',2000000,5000000,30000000,25,200,'migration'),
      ('System','transfer',100000000000,100000000000,1000000000000,100000,1000000,'migration');

    INSERT INTO risk_rules(id, code, event_type, expression, score, action, created_by)
    VALUES
      (gen_random_uuid(),'TRANSFER_VELOCITY_10M','transfer',
       '{"field":"events10m","operator":"gte","value":5}',300,'review','migration'),
      (gen_random_uuid(),'TRANSFER_CIRCULAR_FLOW','transfer',
       '{"field":"circularHops","operator":"gte","value":1}',700,'hold','migration'),
      (gen_random_uuid(),'VOUCHER_VELOCITY_10M','voucher',
       '{"field":"events10m","operator":"gte","value":4}',350,'review','migration'),
      (gen_random_uuid(),'CASHOUT_VELOCITY_10M','cash_out',
       '{"field":"events10m","operator":"gte","value":5}',500,'hold','migration'),
      (gen_random_uuid(),'LINKED_ACCOUNT_CLUSTER','transfer',
       '{"field":"linkedAccounts","operator":"gte","value":5}',400,'review','migration');

    CREATE TABLE risk_list_entries (
      id UUID PRIMARY KEY,
      list_type TEXT NOT NULL CHECK (list_type IN ('allow','block')),
      subject_type TEXT NOT NULL CHECK (subject_type IN
        ('user','account','phone_hash','id_hash','device_hash','ip_hash','beneficiary_hash')),
      subject_hash TEXT NOT NULL,
      reason TEXT NOT NULL,
      expires_at TIMESTAMPTZ,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      revoked_at TIMESTAMPTZ,
      UNIQUE(list_type, subject_type, subject_hash)
    );

    CREATE TABLE risk_signals (
      id UUID PRIMARY KEY,
      event_type TEXT NOT NULL CHECK (event_type IN
        ('transfer','voucher_create','voucher_lookup','voucher_collect','voucher_cancel',
         'otp_request','otp_verify','cash_out','login','webhook')),
      actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      account_id TEXT,
      device_hash TEXT,
      ip_hash TEXT,
      counterparty_hash TEXT,
      amount_cents BIGINT CHECK (amount_cents IS NULL OR amount_cents >= 0),
      financial_reference TEXT,
      request_id TEXT,
      correlation_id TEXT,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE INDEX risk_signals_velocity_idx
      ON risk_signals(event_type, actor_user_id, occurred_at DESC);
    CREATE INDEX risk_signals_device_idx ON risk_signals(device_hash, occurred_at DESC);
    CREATE INDEX risk_signals_counterparty_idx ON risk_signals(counterparty_hash, occurred_at DESC);

    CREATE TABLE linked_identity_edges (
      id UUID PRIMARY KEY,
      left_type TEXT NOT NULL,
      left_hash TEXT NOT NULL,
      right_type TEXT NOT NULL,
      right_hash TEXT NOT NULL,
      signal_count INTEGER NOT NULL DEFAULT 1 CHECK (signal_count > 0),
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      UNIQUE(left_type, left_hash, right_type, right_hash)
    );

    CREATE TABLE risk_evaluations (
      id UUID PRIMARY KEY,
      event_type TEXT NOT NULL,
      actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      financial_reference TEXT,
      score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 1000),
      decision TEXT NOT NULL CHECK (decision IN ('allow','review','hold','block')),
      matched_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
      provider_screening_id TEXT,
      request_id TEXT,
      correlation_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );

    CREATE TABLE sanctions_screenings (
      id UUID PRIMARY KEY,
      provider TEXT NOT NULL,
      provider_reference TEXT NOT NULL,
      subject_hash TEXT NOT NULL,
      screening_type TEXT NOT NULL CHECK (screening_type IN ('sanctions','pep','sanctions_and_pep')),
      decision TEXT NOT NULL CHECK (decision IN ('clear','potential_match','confirmed_match','error')),
      evidence_ref TEXT,
      screened_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ,
      request_id TEXT,
      UNIQUE(provider, provider_reference)
    );

    CREATE TABLE transaction_holds (
      id UUID PRIMARY KEY,
      financial_reference TEXT NOT NULL UNIQUE,
      actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      reason_code TEXT NOT NULL,
      risk_evaluation_id UUID REFERENCES risk_evaluations(id) ON DELETE RESTRICT,
      state TEXT NOT NULL DEFAULT 'held'
        CHECK (state IN ('held','released','rejected','expired')),
      amount_cents BIGINT CHECK (amount_cents IS NULL OR amount_cents > 0),
      held_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      expires_at TIMESTAMPTZ,
      decided_at TIMESTAMPTZ,
      decided_by TEXT,
      decision_reason TEXT
    );

    CREATE TABLE fraud_cases (
      id UUID PRIMARY KEY,
      case_number TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL DEFAULT 'open'
        CHECK (state IN ('open','triage','investigating','awaiting_information','closed')),
      priority TEXT NOT NULL CHECK (priority IN ('low','medium','high','critical')),
      subject_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      assigned_operator_id TEXT REFERENCES ops_admin_users(id) ON DELETE SET NULL,
      risk_evaluation_id UUID REFERENCES risk_evaluations(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      safe_summary TEXT NOT NULL,
      resolution TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      closed_at TIMESTAMPTZ
    );
    CREATE INDEX fraud_cases_queue_idx ON fraud_cases(state, priority, created_at);

    CREATE TABLE fraud_case_notes (
      id UUID PRIMARY KEY,
      case_id UUID NOT NULL REFERENCES fraud_cases(id) ON DELETE RESTRICT,
      author_operator_id TEXT NOT NULL REFERENCES ops_admin_users(id) ON DELETE RESTRICT,
      note TEXT NOT NULL CHECK (length(trim(note)) >= 3),
      evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
      request_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );

    ALTER TABLE cash_send_vouchers
      ADD COLUMN beneficiary_binding_hash TEXT,
      ADD COLUMN lifecycle_version INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN failed_pin_attempts INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN locked_until TIMESTAMPTZ,
      ADD COLUMN hold_transaction_id UUID REFERENCES journal_transactions(id) ON DELETE RESTRICT,
      ADD COLUMN settlement_transaction_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN refund_transaction_id UUID REFERENCES journal_transactions(id) ON DELETE RESTRICT,
      ADD COLUMN expiry_processed_at TIMESTAMPTZ;

    CREATE TABLE cash_send_outbox (
      id UUID PRIMARY KEY,
      voucher_id TEXT NOT NULL REFERENCES cash_send_vouchers(id) ON DELETE RESTRICT,
      event_type TEXT NOT NULL,
      channel TEXT NOT NULL CHECK (channel IN ('sms','push','internal')),
      destination_hash TEXT,
      template TEXT NOT NULL,
      safe_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      request_id TEXT,
      correlation_id TEXT,
      state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending','processing','sent','failed','dead_letter')),
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      locked_until TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      sent_at TIMESTAMPTZ,
      UNIQUE(voucher_id, event_type, template)
    );
    CREATE INDEX cash_send_outbox_pending_idx
      ON cash_send_outbox(state, available_at) WHERE state IN ('pending','failed');

    ALTER TABLE audit_events
      ADD COLUMN actor_type TEXT NOT NULL DEFAULT 'system'
        CHECK (actor_type IN ('user','operator','system','provider')),
      ADD COLUMN actor_id TEXT,
      ADD COLUMN target_type TEXT,
      ADD COLUMN target_id TEXT,
      ADD COLUMN before_hash TEXT,
      ADD COLUMN after_hash TEXT,
      ADD COLUMN safe_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN reason TEXT,
      ADD COLUMN ip_hash TEXT,
      ADD COLUMN device_hash TEXT,
      ADD COLUMN request_id TEXT,
      ADD COLUMN correlation_id TEXT,
      ADD COLUMN financial_reference TEXT;

    CREATE TABLE audit_sink_outbox (
      id UUID PRIMARY KEY,
      audit_event_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id) ON DELETE RESTRICT,
      state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending','processing','sent','failed','dead_letter')),
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      locked_until TIMESTAMPTZ,
      last_error TEXT,
      delivered_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );

    CREATE FUNCTION phase5_immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
    END $$;
    CREATE TRIGGER fraud_notes_immutable BEFORE UPDATE OR DELETE ON fraud_case_notes
      FOR EACH ROW EXECUTE FUNCTION phase5_immutable_record();
    CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events
      FOR EACH ROW EXECUTE FUNCTION phase5_immutable_record();

    CREATE FUNCTION queue_audit_sink() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO audit_sink_outbox(id, audit_event_id) VALUES (gen_random_uuid(), NEW.id);
      RETURN NEW;
    END $$;
    CREATE TRIGGER audit_sink_transactional AFTER INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION queue_audit_sink();

    CREATE FUNCTION require_posting_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.state = 'posted' AND OLD.state IS DISTINCT FROM 'posted' THEN
        INSERT INTO audit_events(
          id, type, message, actor_type, actor_id, target_type, target_id,
          safe_metadata, reason, financial_reference, created_at
        ) VALUES (
          gen_random_uuid()::text, 'financial.posted', 'Financial posting committed',
          CASE WHEN NEW.batch_id IS NULL THEN 'system' ELSE 'system' END,
          NULL, 'journal_transaction', NEW.id::text,
          jsonb_build_object('transactionType', NEW.transaction_type, 'batchId', NEW.batch_id),
          'ledger posting state transition', NEW.reference, clock_timestamp()
        );
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER posted_transaction_audit
      AFTER UPDATE OF state ON journal_transactions
      FOR EACH ROW EXECUTE FUNCTION require_posting_audit();

    CREATE TABLE operational_controls (
      control_key TEXT PRIMARY KEY,
      enabled BOOLEAN NOT NULL,
      version BIGINT NOT NULL DEFAULT 1,
      reason TEXT NOT NULL,
      changed_by TEXT NOT NULL,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    INSERT INTO operational_controls(control_key, enabled, reason, changed_by)
      VALUES ('financial_posting', TRUE, 'initial Phase 5 control state', 'migration');

    CREATE TABLE operational_control_events (
      id UUID PRIMARY KEY,
      control_key TEXT NOT NULL REFERENCES operational_controls(control_key) ON DELETE RESTRICT,
      previous_enabled BOOLEAN NOT NULL,
      enabled BOOLEAN NOT NULL,
      reason TEXT NOT NULL,
      actor_operator_id TEXT NOT NULL REFERENCES ops_admin_users(id) ON DELETE RESTRICT,
      request_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TRIGGER operational_control_events_immutable
      BEFORE UPDATE OR DELETE ON operational_control_events
      FOR EACH ROW EXECUTE FUNCTION phase5_immutable_record();

    CREATE TABLE backup_verification_markers (
      id UUID PRIMARY KEY,
      provider TEXT NOT NULL,
      backup_id_hash TEXT NOT NULL UNIQUE,
      encrypted BOOLEAN NOT NULL,
      pitr_capable BOOLEAN NOT NULL,
      started_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ NOT NULL,
      verified_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ NOT NULL,
      object_inventory_hash TEXT,
      safe_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );

    CREATE TABLE resilience_drill_results (
      id UUID PRIMARY KEY,
      drill_type TEXT NOT NULL CHECK (drill_type IN
        ('api_kill_after_commit','database_loss','provider_timeout','malformed_webhook',
         'duplicate_webhook','dead_letter_recovery','partial_settlement','restore_reconcile')),
      environment TEXT NOT NULL CHECK (environment IN ('test','development','staging','isolated')),
      started_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('passed','failed','aborted')),
      assertions JSONB NOT NULL,
      evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
      runner_version TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
  `);
};

export const down = false;
