/**
 * Phase 4: security, privacy, operator identity and controlled-document baseline.
 *
 * Provider integrations are intentionally represented by durable state only.
 * Production startup validates that private storage and malware scanning are configured.
 */
export const up = (pgm) => {
  pgm.sql(String.raw`
    ALTER TABLE ops_admin_users
      ADD COLUMN token_version INTEGER NOT NULL DEFAULT 1,
      ADD COLUMN mfa_secret_encrypted TEXT,
      ADD COLUMN mfa_enabled_at TIMESTAMPTZ,
      ADD COLUMN password_changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp();

    UPDATE ops_admin_users
       SET role = CASE role
         WHEN 'super_admin' THEN 'admin'
         WHEN 'operator' THEN 'support'
         ELSE 'support'
       END,
       token_version = token_version + 1;
    ALTER TABLE ops_admin_users
      ADD CONSTRAINT ops_admin_role_check
      CHECK (role IN ('admin','operations','compliance','finance','support'));

    CREATE TABLE operator_sessions (
      id UUID PRIMARY KEY,
      operator_id TEXT NOT NULL REFERENCES ops_admin_users(id) ON DELETE CASCADE,
      family_id UUID NOT NULL,
      refresh_token_hash TEXT NOT NULL UNIQUE,
      previous_refresh_hash TEXT UNIQUE,
      token_version INTEGER NOT NULL,
      device_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      expires_at TIMESTAMPTZ NOT NULL,
      absolute_expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      revoke_reason TEXT
    );
    CREATE INDEX operator_sessions_operator_idx ON operator_sessions(operator_id, revoked_at);
    CREATE TABLE operator_refresh_history (
      token_hash TEXT PRIMARY KEY,
      session_id UUID NOT NULL REFERENCES operator_sessions(id) ON DELETE CASCADE,
      family_id UUID NOT NULL,
      used_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE INDEX operator_refresh_history_family_idx ON operator_refresh_history(family_id);

    CREATE TABLE operator_devices (
      id UUID PRIMARY KEY,
      operator_id TEXT NOT NULL REFERENCES ops_admin_users(id) ON DELETE CASCADE,
      install_id_hash TEXT NOT NULL,
      label TEXT NOT NULL,
      platform TEXT,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      trusted_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      UNIQUE(operator_id, install_id_hash)
    );
    ALTER TABLE operator_sessions ADD CONSTRAINT operator_session_device_fk
      FOREIGN KEY (device_id) REFERENCES operator_devices(id) ON DELETE SET NULL;

    CREATE TABLE operator_step_up (
      id UUID PRIMARY KEY,
      operator_id TEXT NOT NULL REFERENCES ops_admin_users(id) ON DELETE CASCADE,
      session_id UUID NOT NULL REFERENCES operator_sessions(id) ON DELETE CASCADE,
      method TEXT NOT NULL CHECK (method IN ('totp','passkey')),
      authenticated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ
    );

    CREATE TABLE approval_requests (
      id UUID PRIMARY KEY,
      action_type TEXT NOT NULL CHECK (action_type IN (
        'loan_disbursement','balance_adjustment','merchant_approval_override',
        'refund_reversal','user_role_change','transaction_limit_change'
      )),
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      payload JSONB NOT NULL,
      reason TEXT NOT NULL CHECK (length(trim(reason)) >= 10),
      evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
      state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending','approved','rejected','expired','executed','cancelled')),
      maker_operator_id TEXT NOT NULL REFERENCES ops_admin_users(id) ON DELETE RESTRICT,
      checker_operator_id TEXT REFERENCES ops_admin_users(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      expires_at TIMESTAMPTZ NOT NULL,
      decided_at TIMESTAMPTZ,
      executed_at TIMESTAMPTZ,
      decision_reason TEXT,
      CHECK (checker_operator_id IS NULL OR checker_operator_id <> maker_operator_id)
    );
    CREATE UNIQUE INDEX approval_one_active_action_idx
      ON approval_requests(action_type, resource_type, resource_id)
      WHERE state IN ('pending','approved');
    CREATE FUNCTION enforce_approval_transition() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.action_type IS DISTINCT FROM OLD.action_type
        OR NEW.resource_type IS DISTINCT FROM OLD.resource_type
        OR NEW.resource_id IS DISTINCT FROM OLD.resource_id
        OR NEW.payload IS DISTINCT FROM OLD.payload
        OR NEW.reason IS DISTINCT FROM OLD.reason
        OR NEW.evidence IS DISTINCT FROM OLD.evidence
        OR NEW.maker_operator_id IS DISTINCT FROM OLD.maker_operator_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
        OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
        RAISE EXCEPTION 'approval request identity and evidence are immutable'
          USING ERRCODE = '55000';
      END IF;
      IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
        OLD.state = 'pending' AND NEW.state IN ('approved','rejected','expired','cancelled')
        OR OLD.state = 'approved' AND NEW.state IN ('executed','expired','cancelled')
      ) THEN
        RAISE EXCEPTION 'invalid approval transition % -> %', OLD.state, NEW.state
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER approval_transition_guard BEFORE UPDATE ON approval_requests
      FOR EACH ROW EXECUTE FUNCTION enforce_approval_transition();

    CREATE TABLE approval_request_events (
      id UUID PRIMARY KEY,
      approval_request_id UUID NOT NULL REFERENCES approval_requests(id) ON DELETE RESTRICT,
      from_state TEXT,
      to_state TEXT NOT NULL,
      actor_operator_id TEXT NOT NULL REFERENCES ops_admin_users(id) ON DELETE RESTRICT,
      reason TEXT NOT NULL,
      evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE FUNCTION immutable_approval_event() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'approval events are append-only' USING ERRCODE = '55000'; END $$;
    CREATE TRIGGER approval_events_immutable BEFORE UPDATE OR DELETE ON approval_request_events
      FOR EACH ROW EXECUTE FUNCTION immutable_approval_event();

    ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE auth_sessions
      ADD COLUMN device_id TEXT,
      ADD COLUMN device_label TEXT,
      ADD COLUMN family_id UUID NOT NULL DEFAULT gen_random_uuid(),
      ADD COLUMN previous_refresh_hash TEXT,
      ADD COLUMN revoke_reason TEXT;
    CREATE UNIQUE INDEX auth_sessions_previous_refresh_idx
      ON auth_sessions(previous_refresh_hash) WHERE previous_refresh_hash IS NOT NULL;

    ALTER TABLE pin_reset_codes
      ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN resend_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN requested_ip_hash TEXT,
      ADD COLUMN consumed_ip_hash TEXT;
    CREATE INDEX pin_reset_daily_limit_idx ON pin_reset_codes(user_id, created_at);

    CREATE TABLE security_notifications_outbox (
      id UUID PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      channel TEXT NOT NULL CHECK (channel IN ('sms','email','push','internal')),
      template TEXT NOT NULL,
      destination_hash TEXT,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sent','failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      sent_at TIMESTAMPTZ,
      last_error TEXT
    );

    CREATE TABLE customer_security_context (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      last_phone_change_at TIMESTAMPTZ,
      recovery_hold_until TIMESTAMPTZ,
      last_recovery_at TIMESTAMPTZ,
      recent_device_policy JSONB NOT NULL DEFAULT '{}'::jsonb
    );

    ALTER TABLE merchant_documents
      ADD COLUMN object_key TEXT,
      ADD COLUMN storage_provider TEXT,
      ADD COLUMN encryption_key_ref TEXT,
      ADD COLUMN scan_state TEXT NOT NULL DEFAULT 'legacy'
        CHECK (scan_state IN ('legacy','pending','clean','infected','failed','quarantined')),
      ADD COLUMN scan_completed_at TIMESTAMPTZ,
      ADD COLUMN quarantined_at TIMESTAMPTZ,
      ADD COLUMN retained_until TIMESTAMPTZ,
      ADD COLUMN deletion_requested_at TIMESTAMPTZ,
      ADD COLUMN deleted_at TIMESTAMPTZ,
      ADD COLUMN metadata_encrypted TEXT;

    CREATE TABLE kyc_cases (
      id UUID PRIMARY KEY,
      merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
      assigned_operator_id TEXT REFERENCES ops_admin_users(id) ON DELETE SET NULL,
      state TEXT NOT NULL DEFAULT 'unassigned'
        CHECK (state IN ('unassigned','assigned','in_review','completed','closed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE(merchant_id)
    );
    CREATE TABLE kyc_document_audit (
      id UUID PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES merchant_documents(id) ON DELETE RESTRICT,
      operator_id TEXT NOT NULL REFERENCES ops_admin_users(id) ON DELETE RESTRICT,
      action TEXT NOT NULL CHECK (action IN ('metadata_read','download_url_issued','downloaded','quarantined','deleted')),
      reason TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE kyc_retention_jobs (
      id UUID PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES merchant_documents(id) ON DELETE RESTRICT,
      action TEXT NOT NULL CHECK (action IN ('quarantine','delete')),
      not_before TIMESTAMPTZ NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','completed','failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );

    CREATE TABLE consent_records (
      id UUID PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      purpose TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('granted','withdrawn')),
      notice_hash TEXT NOT NULL,
      source TEXT NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE INDEX consent_records_current_idx ON consent_records(user_id, purpose, occurred_at DESC);

    CREATE TABLE data_subject_requests (
      id UUID PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      request_type TEXT NOT NULL CHECK (request_type IN ('access','correction','export','deletion')),
      state TEXT NOT NULL DEFAULT 'submitted'
        CHECK (state IN ('submitted','identity_verification','in_review','fulfilled','partially_fulfilled','rejected','cancelled')),
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      assigned_operator_id TEXT REFERENCES ops_admin_users(id) ON DELETE SET NULL,
      due_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      completed_at TIMESTAMPTZ,
      decision_reason TEXT
    );
    CREATE TABLE data_subject_request_events (
      id UUID PRIMARY KEY,
      request_id UUID NOT NULL REFERENCES data_subject_requests(id) ON DELETE RESTRICT,
      state TEXT NOT NULL,
      actor_type TEXT NOT NULL CHECK (actor_type IN ('user','operator','system')),
      actor_id TEXT,
      note TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TRIGGER dsr_events_immutable BEFORE UPDATE OR DELETE ON data_subject_request_events
      FOR EACH ROW EXECUTE FUNCTION immutable_approval_event();

    CREATE TABLE privacy_vendors (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      purpose TEXT NOT NULL,
      data_categories TEXT[] NOT NULL,
      countries TEXT[] NOT NULL,
      cross_border BOOLEAN NOT NULL,
      safeguard_basis TEXT,
      contract_reviewed_at TIMESTAMPTZ,
      next_review_at TIMESTAMPTZ,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );

    CREATE TABLE bootstrap_events (
      id UUID PRIMARY KEY,
      operator_id TEXT NOT NULL REFERENCES ops_admin_users(id) ON DELETE RESTRICT,
      username TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      invocation_hash TEXT NOT NULL
    );
  `);
};

export const down = false;
