/**
 * Phase 8: customer-protection evidence and release-readiness records.
 *
 * This migration intentionally seeds no acceptance, release approval, legal
 * decision, drill result, or provider credential. Production remains blocked.
 */
export const up = (pgm) => {
  pgm.sql(String.raw`
    CREATE TABLE customer_statement_exports (
      id UUID PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      format TEXT NOT NULL CHECK (format IN ('json','csv','pdf')),
      query JSONB NOT NULL,
      item_count INTEGER NOT NULL CHECK (item_count >= 0),
      content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
      object_uri TEXT,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );

    CREATE TABLE durable_receipts (
      id UUID PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      resource_type TEXT NOT NULL CHECK (resource_type IN
        ('transaction','sale','transfer','cash_send','utility','refund','settlement','closing_withdrawal')),
      resource_id TEXT NOT NULL,
      receipt_number TEXT NOT NULL UNIQUE,
      amount_cents BIGINT NOT NULL CHECK (amount_cents >= 0),
      fee_cents BIGINT NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
      currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
      status TEXT NOT NULL,
      content JSONB NOT NULL,
      content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
      issued_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE(resource_type,resource_id,user_id)
    );

    CREATE TABLE fee_confirmation_evidence (
      id UUID PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      authenticated_session_id TEXT NOT NULL REFERENCES auth_sessions(id) ON DELETE RESTRICT,
      quote_id TEXT NOT NULL,
      operation_type TEXT NOT NULL CHECK (operation_type IN
        ('transfer','cash_send','utility','sale','refund','closing_withdrawal')),
      principal_cents BIGINT NOT NULL CHECK (principal_cents > 0),
      fee_cents BIGINT NOT NULL CHECK (fee_cents >= 0),
      total_cents BIGINT NOT NULL CHECK (total_cents = principal_cents + fee_cents),
      currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
      disclosure_version TEXT NOT NULL,
      disclosure_sha256 TEXT NOT NULL CHECK (disclosure_sha256 ~ '^[0-9a-f]{64}$'),
      acceptance_text TEXT NOT NULL,
      evidence_sha256 TEXT NOT NULL UNIQUE CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
      confirmed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_by_resource_id TEXT,
      CHECK (expires_at > confirmed_at)
    );

    CREATE TABLE customer_notification_preferences (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
      login_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      transaction_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      security_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      complaint_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      refund_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      channels JSONB NOT NULL DEFAULT '["in_app"]'::jsonb,
      locale TEXT NOT NULL DEFAULT 'en-ZA',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );

    CREATE TABLE customer_notifications (
      id UUID PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      event_type TEXT NOT NULL CHECK (event_type IN
        ('login','transaction','security','complaint','refund','account','terms')),
      channel TEXT NOT NULL CHECK (channel IN ('in_app','sms','email','push')),
      template_version TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      resource_type TEXT,
      resource_id TEXT,
      delivery_state TEXT NOT NULL DEFAULT 'queued'
        CHECK (delivery_state IN ('queued','sent','delivered','failed','suppressed')),
      provider_reference TEXT,
      failure_code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      delivered_at TIMESTAMPTZ
    );
    CREATE INDEX customer_notifications_user_created_idx
      ON customer_notifications(user_id,created_at DESC);

    CREATE TABLE customer_cases (
      id UUID PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      case_number TEXT NOT NULL UNIQUE,
      case_type TEXT NOT NULL CHECK (case_type IN
        ('incorrect_payment','suspected_fraud','complaint','dispute','account_recovery','refund_query')),
      subject TEXT NOT NULL,
      description TEXT NOT NULL,
      resource_type TEXT,
      resource_id TEXT,
      priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
      state TEXT NOT NULL DEFAULT 'submitted' CHECK (state IN
        ('submitted','acknowledged','investigating','awaiting_customer','resolved','rejected','escalated','closed')),
      acknowledged_due_at TIMESTAMPTZ NOT NULL,
      resolution_due_at TIMESTAMPTZ NOT NULL,
      acknowledged_at TIMESTAMPTZ,
      resolved_at TIMESTAMPTZ,
      resolution TEXT,
      assigned_operator_id TEXT REFERENCES ops_admin_users(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CHECK (resolution_due_at > acknowledged_due_at),
      CHECK (resolved_at IS NULL OR resolution IS NOT NULL)
    );
    CREATE INDEX customer_cases_user_created_idx ON customer_cases(user_id,created_at DESC);
    CREATE INDEX customer_cases_sla_idx ON customer_cases(state,acknowledged_due_at,resolution_due_at);

    CREATE TABLE customer_case_events (
      id UUID PRIMARY KEY,
      case_id UUID NOT NULL REFERENCES customer_cases(id) ON DELETE RESTRICT,
      event_type TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT,
      actor_type TEXT NOT NULL CHECK (actor_type IN ('user','operator','system')),
      actor_id TEXT NOT NULL,
      notes TEXT NOT NULL,
      evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );

    CREATE TABLE account_protection_actions (
      id UUID PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      action TEXT NOT NULL CHECK (action IN ('freeze','unfreeze','recovery_start','recovery_complete')),
      state TEXT NOT NULL CHECK (state IN ('requested','verified','applied','rejected','expired')),
      reason TEXT NOT NULL,
      requested_by_type TEXT NOT NULL CHECK (requested_by_type IN ('user','operator','system')),
      requested_by_id TEXT NOT NULL,
      authenticated_session_id TEXT REFERENCES auth_sessions(id) ON DELETE RESTRICT,
      case_id UUID REFERENCES customer_cases(id) ON DELETE RESTRICT,
      verification_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      applied_at TIMESTAMPTZ
    );
    CREATE INDEX account_protection_user_created_idx
      ON account_protection_actions(user_id,created_at DESC);

    CREATE TABLE customer_terms_versions (
      id UUID PRIMARY KEY,
      document_type TEXT NOT NULL CHECK (document_type IN
        ('platform_terms','privacy_notice','fee_schedule','wallet_terms')),
      version TEXT NOT NULL,
      locale TEXT NOT NULL,
      content_uri TEXT NOT NULL,
      content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
      summary TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','published','retired')),
      effective_at TIMESTAMPTZ,
      supersedes_id UUID REFERENCES customer_terms_versions(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE(document_type,version,locale),
      CHECK (state <> 'published' OR effective_at IS NOT NULL)
    );

    CREATE TABLE customer_terms_acceptances (
      id UUID PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      terms_version_id UUID NOT NULL REFERENCES customer_terms_versions(id) ON DELETE RESTRICT,
      authenticated_session_id TEXT NOT NULL REFERENCES auth_sessions(id) ON DELETE RESTRICT,
      acceptance_text TEXT NOT NULL,
      acceptance_sha256 TEXT NOT NULL CHECK (acceptance_sha256 ~ '^[0-9a-f]{64}$'),
      ip_hash TEXT,
      user_agent_hash TEXT,
      accepted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE(user_id,terms_version_id)
    );

    CREATE TABLE closing_balance_withdrawals (
      id UUID PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      wallet_id TEXT NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
      destination_type TEXT NOT NULL CHECK (destination_type IN ('bank_account','cash_voucher','other_wallet')),
      destination_token TEXT NOT NULL,
      requested_cents BIGINT NOT NULL CHECK (requested_cents >= 0),
      fee_cents BIGINT NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
      state TEXT NOT NULL DEFAULT 'requested' CHECK (state IN
        ('requested','verification_required','verified','pending','paid','failed','cancelled','escalated')),
      fee_confirmation_id UUID REFERENCES fee_confirmation_evidence(id) ON DELETE RESTRICT,
      provider_instruction_id UUID REFERENCES provider_instructions(id) ON DELETE RESTRICT,
      journal_transaction_id UUID REFERENCES journal_transactions(id) ON DELETE RESTRICT,
      case_id UUID REFERENCES customer_cases(id) ON DELETE RESTRICT,
      failure_reason TEXT,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      completed_at TIMESTAMPTZ,
      CHECK (state <> 'paid' OR (journal_transaction_id IS NOT NULL AND completed_at IS NOT NULL))
    );

    CREATE TABLE refund_status_events (
      id UUID PRIMARY KEY,
      refund_request_id UUID NOT NULL REFERENCES refund_requests(id) ON DELETE RESTRICT,
      state TEXT NOT NULL,
      customer_message TEXT NOT NULL,
      expected_resolution_at TIMESTAMPTZ,
      actor_type TEXT NOT NULL CHECK (actor_type IN ('operator','system','provider')),
      actor_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );

    CREATE TABLE release_evidence (
      id UUID PRIMARY KEY,
      release_sha TEXT NOT NULL,
      environment TEXT NOT NULL CHECK (environment IN ('staging','production')),
      control TEXT NOT NULL CHECK (control IN
        ('migrations','configuration','tests','security_scan','sbom','provenance',
         'legal','provider','backup','restore_drill','failure_drill','smoke','rollback')),
      status TEXT NOT NULL CHECK (status IN ('passed','failed','approved','expired')),
      artifact_uri TEXT NOT NULL,
      artifact_sha256 TEXT NOT NULL CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
      authority TEXT NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      expires_at TIMESTAMPTZ,
      UNIQUE(release_sha,environment,control,artifact_sha256)
    );

    CREATE TRIGGER durable_receipts_immutable BEFORE UPDATE OR DELETE ON durable_receipts
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
    CREATE TRIGGER fee_confirmations_immutable BEFORE DELETE ON fee_confirmation_evidence
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
    CREATE TRIGGER customer_case_events_immutable BEFORE UPDATE OR DELETE ON customer_case_events
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
    CREATE TRIGGER terms_versions_immutable BEFORE UPDATE OR DELETE ON customer_terms_versions
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
    CREATE TRIGGER terms_acceptances_immutable BEFORE UPDATE OR DELETE ON customer_terms_acceptances
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
    CREATE TRIGGER refund_status_events_immutable BEFORE UPDATE OR DELETE ON refund_status_events
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
    CREATE TRIGGER release_evidence_immutable BEFORE UPDATE OR DELETE ON release_evidence
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
  `);
};

export const down = false;
