/**
 * Phase 7: fail-closed readiness evidence and append-only regulated products.
 *
 * No production gate is seeded as approved. No live provider is configured.
 * Legacy rows are inventoried for explicit conversion, never silently mutated.
 */
export const up = (pgm) => {
  pgm.sql(String.raw`
    ALTER TABLE approval_requests DROP CONSTRAINT approval_requests_action_type_check;
    ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_action_type_check
      CHECK (action_type IN (
        'loan_disbursement','loan_write_off','balance_adjustment',
        'merchant_approval_override','refund_reversal','user_role_change',
        'transaction_limit_change','settlement_resolution','daily_close',
        'fee_schedule_publish'
      ));

    CREATE TYPE regulated_product AS ENUM
      ('stokvel','lending','merchant_credit','insurance','utilities');
    CREATE TYPE product_environment AS ENUM ('sandbox','production');
    CREATE TYPE readiness_control AS ENUM
      ('legal','provider','accounting','customer_journey','reconciliation','testing','runbook');

    CREATE TABLE product_readiness_evidence (
      id UUID PRIMARY KEY,
      product regulated_product NOT NULL,
      environment product_environment NOT NULL,
      control readiness_control NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('approved','rejected','withdrawn')),
      authority TEXT NOT NULL,
      authority_reference TEXT NOT NULL,
      artifact_uri TEXT NOT NULL,
      artifact_sha256 TEXT NOT NULL CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
      evidence_sha256 TEXT NOT NULL UNIQUE CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
      notes TEXT NOT NULL,
      recorded_by TEXT NOT NULL REFERENCES ops_admin_users(id) ON DELETE RESTRICT,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      expires_at TIMESTAMPTZ,
      CHECK (expires_at IS NULL OR expires_at > recorded_at)
    );
    CREATE INDEX product_readiness_latest_idx
      ON product_readiness_evidence(product,environment,control,recorded_at DESC);

    CREATE TABLE product_readiness_checks (
      id UUID PRIMARY KEY,
      product regulated_product NOT NULL,
      environment product_environment NOT NULL,
      database_approved BOOLEAN NOT NULL,
      config_enabled BOOLEAN NOT NULL,
      enabled BOOLEAN NOT NULL,
      evidence_snapshot JSONB NOT NULL,
      snapshot_sha256 TEXT NOT NULL CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
      checked_by TEXT REFERENCES ops_admin_users(id) ON DELETE RESTRICT,
      checked_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CHECK (NOT enabled OR (database_approved AND config_enabled))
    );

    CREATE TABLE product_accounting_mappings (
      id UUID PRIMARY KEY,
      product regulated_product NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      event_type TEXT NOT NULL,
      debit_account_id TEXT NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
      credit_account_id TEXT NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
      state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','approved','retired')),
      evidence_id UUID REFERENCES product_readiness_evidence(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE(product,version,event_type),
      CHECK (debit_account_id <> credit_account_id)
    );
    CREATE TABLE product_journey_versions (
      id UUID PRIMARY KEY,
      product regulated_product NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      locale TEXT NOT NULL,
      content JSONB NOT NULL,
      content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
      state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','approved','retired')),
      evidence_id UUID REFERENCES product_readiness_evidence(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE(product,version,locale)
    );
    CREATE TABLE product_reconciliation_runs (
      id UUID PRIMARY KEY,
      product regulated_product NOT NULL,
      period_start TIMESTAMPTZ NOT NULL,
      period_end TIMESTAMPTZ NOT NULL,
      expected_cents BIGINT NOT NULL,
      actual_cents BIGINT NOT NULL,
      break_cents BIGINT NOT NULL,
      item_count INTEGER NOT NULL CHECK (item_count >= 0),
      break_count INTEGER NOT NULL CHECK (break_count >= 0),
      report JSONB NOT NULL,
      report_sha256 TEXT NOT NULL CHECK (report_sha256 ~ '^[0-9a-f]{64}$'),
      state TEXT NOT NULL CHECK (state IN ('passed','failed','investigating')),
      run_by TEXT NOT NULL REFERENCES ops_admin_users(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CHECK (period_end > period_start),
      CHECK (break_cents = actual_cents - expected_cents)
    );
    CREATE TABLE product_failure_test_runs (
      id UUID PRIMARY KEY,
      product regulated_product NOT NULL,
      scenario TEXT NOT NULL,
      build_sha TEXT NOT NULL,
      passed BOOLEAN NOT NULL,
      evidence JSONB NOT NULL,
      evidence_sha256 TEXT NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
      run_by TEXT NOT NULL,
      run_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE product_runbook_versions (
      id UUID PRIMARY KEY,
      product regulated_product NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      document_uri TEXT NOT NULL,
      document_sha256 TEXT NOT NULL CHECK (document_sha256 ~ '^[0-9a-f]{64}$'),
      owner TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','approved','retired')),
      evidence_id UUID REFERENCES product_readiness_evidence(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE(product,version)
    );

    INSERT INTO ledger_accounts
      (id,code,name,account_class,normal_side,currency,pool_id,allow_negative)
    VALUES
      ('p7-stokvel-custody-zar','P7-STOKVEL-CUSTODY-ZAR','Stokvel custody asset','asset','debit','ZAR','ZA',FALSE),
      ('p7-stokvel-member-zar','P7-STOKVEL-MEMBER-ZAR','Stokvel member liability','liability','credit','ZAR','ZA',FALSE),
      ('p7-loan-principal-zar','P7-LOAN-PRINCIPAL-ZAR','Loan principal receivable','asset','debit','ZAR','ZA',TRUE),
      ('p7-loan-interest-zar','P7-LOAN-INTEREST-ZAR','Loan interest receivable','asset','debit','ZAR','ZA',TRUE),
      ('p7-loan-fee-zar','P7-LOAN-FEE-ZAR','Loan fee receivable','asset','debit','ZAR','ZA',TRUE),
      ('p7-loan-impairment-zar','P7-LOAN-IMPAIRMENT-ZAR','Loan impairment allowance','asset','credit','ZAR','ZA',TRUE),
      ('p7-credit-receivable-zar','P7-CREDIT-RECEIVABLE-ZAR','Merchant credit receivable','asset','debit','ZAR','ZA',TRUE),
      ('p7-insurance-premium-zar','P7-INSURANCE-PREMIUM-ZAR','Insurance premium liability','liability','credit','ZAR','ZA',FALSE),
      ('p7-insurance-claims-zar','P7-INSURANCE-CLAIMS-ZAR','Insurance claims payable','liability','credit','ZAR','ZA',FALSE),
      ('p7-utility-prefund-zar','P7-UTILITY-PREFUND-ZAR','Utility provider prefund','asset','debit','ZAR','ZA',FALSE),
      ('p7-utility-suspense-zar','P7-UTILITY-SUSPENSE-ZAR','Utility fulfillment suspense','asset','debit','ZAR','ZA',TRUE)
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO account_balance_projections(account_id)
      SELECT id FROM ledger_accounts WHERE id LIKE 'p7-%'
      ON CONFLICT (account_id) DO NOTHING;

    CREATE TABLE stokvel_accounts (
      id UUID PRIMARY KEY,
      legacy_group_id TEXT UNIQUE REFERENCES stokvel_groups(id) ON DELETE RESTRICT,
      name TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'ZAR' CHECK (currency ~ '^[A-Z]{3}$'),
      custody_account_id TEXT NOT NULL UNIQUE REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
      member_liability_account_id TEXT NOT NULL UNIQUE REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
      legal_custodian_name TEXT,
      legal_custodian_reference TEXT,
      legal_custodian_evidence_id UUID REFERENCES product_readiness_evidence(id) ON DELETE RESTRICT,
      state TEXT NOT NULL DEFAULT 'conversion_pending'
        CHECK (state IN ('conversion_pending','draft','active','frozen','closing','closed','disputed')),
      created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CHECK (state <> 'active' OR
             (legal_custodian_name IS NOT NULL AND legal_custodian_evidence_id IS NOT NULL))
    );
    CREATE TABLE stokvel_constitution_versions (
      id UUID PRIMARY KEY,
      stokvel_account_id UUID NOT NULL REFERENCES stokvel_accounts(id) ON DELETE RESTRICT,
      version INTEGER NOT NULL CHECK (version > 0),
      content JSONB NOT NULL,
      content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
      voting_threshold_bps INTEGER NOT NULL CHECK (voting_threshold_bps BETWEEN 1 AND 10000),
      withdrawal_approval_count INTEGER NOT NULL CHECK (withdrawal_approval_count >= 2),
      effective_at TIMESTAMPTZ,
      supersedes_id UUID REFERENCES stokvel_constitution_versions(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE(stokvel_account_id,version)
    );
    CREATE TABLE stokvel_memberships (
      id UUID PRIMARY KEY,
      stokvel_account_id UUID NOT NULL REFERENCES stokvel_accounts(id) ON DELETE RESTRICT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      role TEXT NOT NULL CHECK (role IN ('chair','treasurer','secretary','member','auditor')),
      state TEXT NOT NULL DEFAULT 'invited'
        CHECK (state IN ('invited','active','suspended','removed','resigned')),
      joined_at TIMESTAMPTZ,
      ended_at TIMESTAMPTZ,
      removal_reason TEXT,
      UNIQUE(stokvel_account_id,user_id)
    );
    CREATE TABLE stokvel_member_consents (
      id UUID PRIMARY KEY,
      membership_id UUID NOT NULL REFERENCES stokvel_memberships(id) ON DELETE RESTRICT,
      constitution_version_id UUID NOT NULL REFERENCES stokvel_constitution_versions(id) ON DELETE RESTRICT,
      acceptance_text TEXT NOT NULL,
      acceptance_sha256 TEXT NOT NULL CHECK (acceptance_sha256 ~ '^[0-9a-f]{64}$'),
      authenticated_session_id TEXT NOT NULL REFERENCES auth_sessions(id) ON DELETE RESTRICT,
      accepted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE(membership_id,constitution_version_id)
    );
    CREATE TABLE stokvel_contribution_records (
      id UUID PRIMARY KEY,
      stokvel_account_id UUID NOT NULL REFERENCES stokvel_accounts(id) ON DELETE RESTRICT,
      membership_id UUID NOT NULL REFERENCES stokvel_memberships(id) ON DELETE RESTRICT,
      period_start DATE NOT NULL,
      period_end DATE NOT NULL,
      due_cents BIGINT NOT NULL CHECK (due_cents > 0),
      paid_cents BIGINT NOT NULL CHECK (paid_cents >= 0),
      state TEXT NOT NULL CHECK (state IN ('due','partial','paid','missed','waived')),
      source_journal_transaction_id UUID REFERENCES journal_transactions(id) ON DELETE RESTRICT,
      adjustment_of_id UUID REFERENCES stokvel_contribution_records(id) ON DELETE RESTRICT,
      reason TEXT NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CHECK (period_end >= period_start),
      CHECK (adjustment_of_id IS NULL OR source_journal_transaction_id IS NOT NULL)
    );
    CREATE TABLE stokvel_withdrawal_requests (
      id UUID PRIMARY KEY,
      stokvel_account_id UUID NOT NULL REFERENCES stokvel_accounts(id) ON DELETE RESTRICT,
      requested_by_membership_id UUID NOT NULL REFERENCES stokvel_memberships(id) ON DELETE RESTRICT,
      amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
      purpose TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending','approved','rejected','posted','cancelled','expired')),
      required_approvals INTEGER NOT NULL CHECK (required_approvals >= 2),
      journal_transaction_id UUID UNIQUE REFERENCES journal_transactions(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE stokvel_withdrawal_approvals (
      id UUID PRIMARY KEY,
      withdrawal_request_id UUID NOT NULL REFERENCES stokvel_withdrawal_requests(id) ON DELETE RESTRICT,
      membership_id UUID NOT NULL REFERENCES stokvel_memberships(id) ON DELETE RESTRICT,
      decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
      reason TEXT NOT NULL,
      decided_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE(withdrawal_request_id,membership_id)
    );
    CREATE TABLE stokvel_disputes (
      id UUID PRIMARY KEY,
      stokvel_account_id UUID NOT NULL REFERENCES stokvel_accounts(id) ON DELETE RESTRICT,
      opened_by_membership_id UUID NOT NULL REFERENCES stokvel_memberships(id) ON DELETE RESTRICT,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'open'
        CHECK (state IN ('open','investigating','resolved','rejected','escalated')),
      description TEXT NOT NULL,
      resolution TEXT,
      opened_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      resolved_at TIMESTAMPTZ
    );
    CREATE TABLE stokvel_state_events (
      id UUID PRIMARY KEY,
      stokvel_account_id UUID NOT NULL REFERENCES stokvel_accounts(id) ON DELETE RESTRICT,
      event_type TEXT NOT NULL,
      actor_type TEXT NOT NULL CHECK (actor_type IN ('member','operator','system')),
      actor_id TEXT NOT NULL,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE stokvel_legacy_conversion (
      id UUID PRIMARY KEY,
      legacy_group_id TEXT NOT NULL UNIQUE REFERENCES stokvel_groups(id) ON DELETE RESTRICT,
      target_stokvel_account_id UUID REFERENCES stokvel_accounts(id) ON DELETE RESTRICT,
      legacy_snapshot JSONB NOT NULL,
      snapshot_sha256 TEXT NOT NULL CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
      expected_cents BIGINT NOT NULL,
      converted_cents BIGINT,
      state TEXT NOT NULL DEFAULT 'inventoried'
        CHECK (state IN ('inventoried','reconciled','approved','converted','rejected')),
      maker_operator_id TEXT REFERENCES ops_admin_users(id) ON DELETE RESTRICT,
      checker_operator_id TEXT REFERENCES ops_admin_users(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CHECK (checker_operator_id IS NULL OR checker_operator_id <> maker_operator_id),
      CHECK (state <> 'converted' OR converted_cents = expected_cents)
    );
    CREATE TABLE lending_product_versions (
      id UUID PRIMARY KEY,
      code TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      currency TEXT NOT NULL DEFAULT 'ZAR',
      min_principal_cents BIGINT NOT NULL CHECK (min_principal_cents > 0),
      max_principal_cents BIGINT NOT NULL CHECK (max_principal_cents >= min_principal_cents),
      term_count INTEGER NOT NULL CHECK (term_count > 0),
      term_unit TEXT NOT NULL CHECK (term_unit IN ('week','month')),
      interest_bps INTEGER NOT NULL CHECK (interest_bps BETWEEN 0 AND 10000),
      initiation_fee_cents BIGINT NOT NULL CHECK (initiation_fee_cents >= 0),
      service_fee_cents BIGINT NOT NULL CHECK (service_fee_cents >= 0),
      disclosure JSONB NOT NULL,
      disclosure_sha256 TEXT NOT NULL CHECK (disclosure_sha256 ~ '^[0-9a-f]{64}$'),
      lender_of_record TEXT,
      nca_decision_reference TEXT,
      readiness_evidence_id UUID REFERENCES product_readiness_evidence(id) ON DELETE RESTRICT,
      state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','approved','retired')),
      effective_from TIMESTAMPTZ,
      effective_to TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE(code,version),
      CHECK (state <> 'approved' OR
             (lender_of_record IS NOT NULL AND nca_decision_reference IS NOT NULL
              AND readiness_evidence_id IS NOT NULL))
    );
    CREATE TABLE lending_applications (
      id UUID PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      product_version_id UUID NOT NULL REFERENCES lending_product_versions(id) ON DELETE RESTRICT,
      requested_principal_cents BIGINT NOT NULL CHECK (requested_principal_cents > 0),
      state TEXT NOT NULL DEFAULT 'submitted'
        CHECK (state IN ('submitted','assessed','offered','accepted','declined','expired','cancelled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE lending_affordability_assessments (
      id UUID PRIMARY KEY,
      application_id UUID NOT NULL UNIQUE REFERENCES lending_applications(id) ON DELETE RESTRICT,
      income_cents BIGINT NOT NULL CHECK (income_cents >= 0),
      expense_cents BIGINT NOT NULL CHECK (expense_cents >= 0),
      existing_debt_cents BIGINT NOT NULL CHECK (existing_debt_cents >= 0),
      disposable_cents BIGINT NOT NULL,
      eligible BOOLEAN NOT NULL,
      rules_version TEXT NOT NULL,
      inputs JSONB NOT NULL,
      evidence JSONB NOT NULL,
      assessed_by TEXT NOT NULL,
      assessed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CHECK (disposable_cents = income_cents - expense_cents - existing_debt_cents)
    );
    CREATE TABLE lending_agreements (
      id UUID PRIMARY KEY,
      application_id UUID NOT NULL UNIQUE REFERENCES lending_applications(id) ON DELETE RESTRICT,
      agreement_version TEXT NOT NULL,
      agreement_sha256 TEXT NOT NULL CHECK (agreement_sha256 ~ '^[0-9a-f]{64}$'),
      disclosure_sha256 TEXT NOT NULL CHECK (disclosure_sha256 ~ '^[0-9a-f]{64}$'),
      signed_evidence JSONB NOT NULL,
      authenticated_session_id TEXT NOT NULL REFERENCES auth_sessions(id) ON DELETE RESTRICT,
      accepted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE regulated_loans (
      id UUID PRIMARY KEY,
      application_id UUID NOT NULL UNIQUE REFERENCES lending_applications(id) ON DELETE RESTRICT,
      principal_cents BIGINT NOT NULL CHECK (principal_cents > 0),
      interest_cents BIGINT NOT NULL CHECK (interest_cents >= 0),
      fee_cents BIGINT NOT NULL CHECK (fee_cents >= 0),
      principal_outstanding_cents BIGINT NOT NULL CHECK (principal_outstanding_cents >= 0),
      interest_outstanding_cents BIGINT NOT NULL CHECK (interest_outstanding_cents >= 0),
      fee_outstanding_cents BIGINT NOT NULL CHECK (fee_outstanding_cents >= 0),
      impairment_cents BIGINT NOT NULL DEFAULT 0 CHECK (impairment_cents >= 0),
      state TEXT NOT NULL DEFAULT 'pending_disbursement'
        CHECK (state IN ('pending_disbursement','active','due','arrears','restructured',
                         'settled','written_off','cancelled')),
      disbursement_approval_id UUID REFERENCES approval_requests(id) ON DELETE RESTRICT,
      write_off_approval_id UUID REFERENCES approval_requests(id) ON DELETE RESTRICT,
      disbursement_journal_id UUID UNIQUE REFERENCES journal_transactions(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE loan_schedule_items (
      id UUID PRIMARY KEY,
      loan_id UUID NOT NULL REFERENCES regulated_loans(id) ON DELETE RESTRICT,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      due_date DATE NOT NULL,
      principal_cents BIGINT NOT NULL CHECK (principal_cents >= 0),
      interest_cents BIGINT NOT NULL CHECK (interest_cents >= 0),
      fee_cents BIGINT NOT NULL CHECK (fee_cents >= 0),
      state TEXT NOT NULL DEFAULT 'scheduled'
        CHECK (state IN ('scheduled','due','partial','paid','arrears','waived')),
      UNIQUE(loan_id,sequence)
    );
    CREATE TABLE loan_repayments (
      id UUID PRIMARY KEY,
      loan_id UUID NOT NULL REFERENCES regulated_loans(id) ON DELETE RESTRICT,
      amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
      journal_transaction_id UUID NOT NULL UNIQUE REFERENCES journal_transactions(id) ON DELETE RESTRICT,
      received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE loan_repayment_allocations (
      id UUID PRIMARY KEY,
      repayment_id UUID NOT NULL REFERENCES loan_repayments(id) ON DELETE RESTRICT,
      component TEXT NOT NULL CHECK (component IN ('fee','interest','principal')),
      amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
      sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 3),
      UNIQUE(repayment_id,component),
      UNIQUE(repayment_id,sequence)
    );
    CREATE TABLE loan_state_events (
      id UUID PRIMARY KEY,
      loan_id UUID NOT NULL REFERENCES regulated_loans(id) ON DELETE RESTRICT,
      from_state TEXT,
      to_state TEXT NOT NULL,
      reason TEXT NOT NULL,
      actor_type TEXT NOT NULL CHECK (actor_type IN ('user','operator','system')),
      actor_id TEXT NOT NULL,
      evidence JSONB NOT NULL,
      approval_request_id UUID REFERENCES approval_requests(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE loan_settlement_quotes (
      id UUID PRIMARY KEY,
      loan_id UUID NOT NULL REFERENCES regulated_loans(id) ON DELETE RESTRICT,
      principal_cents BIGINT NOT NULL,
      interest_cents BIGINT NOT NULL,
      fee_cents BIGINT NOT NULL,
      rebate_cents BIGINT NOT NULL CHECK (rebate_cents >= 0),
      total_cents BIGINT NOT NULL CHECK (total_cents >= 0),
      statutory_disclosure JSONB NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CHECK (total_cents = principal_cents + interest_cents + fee_cents - rebate_cents)
    );

    CREATE TABLE merchant_credit_term_versions (
      id UUID PRIMARY KEY,
      merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
      version INTEGER NOT NULL CHECK (version > 0),
      terms JSONB NOT NULL,
      terms_sha256 TEXT NOT NULL CHECK (terms_sha256 ~ '^[0-9a-f]{64}$'),
      classification TEXT NOT NULL CHECK
        (classification IN ('book_debt','incidental_credit','credit_agreement','undetermined')),
      classification_evidence_id UUID REFERENCES product_readiness_evidence(id) ON DELETE RESTRICT,
      state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','approved','retired')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE(merchant_id,version),
      CHECK (state <> 'approved' OR
             (classification <> 'undetermined' AND classification_evidence_id IS NOT NULL))
    );
    CREATE TABLE merchant_credit_obligations (
      id UUID PRIMARY KEY,
      customer_id TEXT NOT NULL REFERENCES credit_customers(id) ON DELETE RESTRICT,
      sale_id TEXT REFERENCES sales(id) ON DELETE RESTRICT,
      terms_version_id UUID NOT NULL REFERENCES merchant_credit_term_versions(id) ON DELETE RESTRICT,
      principal_cents BIGINT NOT NULL CHECK (principal_cents > 0),
      outstanding_cents BIGINT NOT NULL CHECK (outstanding_cents >= 0),
      state TEXT NOT NULL DEFAULT 'open'
        CHECK (state IN ('open','partial','settled','disputed','written_off','reversed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE merchant_credit_consents (
      id UUID PRIMARY KEY,
      obligation_id UUID NOT NULL UNIQUE REFERENCES merchant_credit_obligations(id) ON DELETE RESTRICT,
      acceptance_text TEXT NOT NULL,
      acceptance_sha256 TEXT NOT NULL CHECK (acceptance_sha256 ~ '^[0-9a-f]{64}$'),
      otp_verification_id TEXT REFERENCES credit_otp_codes(id) ON DELETE RESTRICT,
      accepted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE merchant_credit_events (
      id UUID PRIMARY KEY,
      obligation_id UUID NOT NULL REFERENCES merchant_credit_obligations(id) ON DELETE RESTRICT,
      event_type TEXT NOT NULL CHECK
        (event_type IN ('purchase','payment','adjustment','reversal','write_off','reopen')),
      amount_cents BIGINT NOT NULL,
      effective_cents BIGINT NOT NULL,
      reversal_of_id UUID UNIQUE REFERENCES merchant_credit_events(id) ON DELETE RESTRICT,
      reason TEXT NOT NULL,
      actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
      journal_transaction_id UUID REFERENCES journal_transactions(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CHECK (event_type NOT IN ('adjustment','reversal') OR reason <> '')
    );
    CREATE TABLE merchant_credit_allocations (
      id UUID PRIMARY KEY,
      payment_event_id UUID NOT NULL REFERENCES merchant_credit_events(id) ON DELETE RESTRICT,
      purchase_event_id UUID NOT NULL REFERENCES merchant_credit_events(id) ON DELETE RESTRICT,
      amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
      allocation_order INTEGER NOT NULL CHECK (allocation_order > 0),
      UNIQUE(payment_event_id,purchase_event_id),
      UNIQUE(payment_event_id,allocation_order)
    );
    CREATE TABLE merchant_credit_disputes (
      id UUID PRIMARY KEY,
      obligation_id UUID NOT NULL REFERENCES merchant_credit_obligations(id) ON DELETE RESTRICT,
      event_id UUID REFERENCES merchant_credit_events(id) ON DELETE RESTRICT,
      state TEXT NOT NULL DEFAULT 'open'
        CHECK (state IN ('open','investigating','correction_proposed','resolved','rejected')),
      description TEXT NOT NULL,
      resolution_event_id UUID REFERENCES merchant_credit_events(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE merchant_credit_field_grants (
      id UUID PRIMARY KEY,
      merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
      employee_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      field_name TEXT NOT NULL CHECK
        (field_name IN ('customer_name','customer_phone','balance','transactions','consent','disputes')),
      granted BOOLEAN NOT NULL,
      granted_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );

    CREATE TABLE insurance_providers (
      id UUID PRIMARY KEY,
      legal_name TEXT NOT NULL,
      licence_reference TEXT,
      intermediary_reference TEXT,
      certification_evidence_id UUID REFERENCES product_readiness_evidence(id) ON DELETE RESTRICT,
      state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending','certified','suspended','retired')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CHECK (state <> 'certified' OR
             (licence_reference IS NOT NULL AND certification_evidence_id IS NOT NULL))
    );
    CREATE TABLE insurance_product_versions (
      id UUID PRIMARY KEY,
      provider_id UUID NOT NULL REFERENCES insurance_providers(id) ON DELETE RESTRICT,
      code TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      premium_cents BIGINT NOT NULL CHECK (premium_cents > 0),
      cover_cents BIGINT NOT NULL CHECK (cover_cents > 0),
      grace_days INTEGER NOT NULL CHECK (grace_days >= 0),
      cooling_off_days INTEGER NOT NULL CHECK (cooling_off_days >= 0),
      wording JSONB NOT NULL,
      wording_sha256 TEXT NOT NULL CHECK (wording_sha256 ~ '^[0-9a-f]{64}$'),
      disclosure JSONB NOT NULL,
      disclosure_sha256 TEXT NOT NULL CHECK (disclosure_sha256 ~ '^[0-9a-f]{64}$'),
      state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','published','retired')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE(provider_id,code,version)
    );
    CREATE TABLE insurance_policy_acceptances (
      id UUID PRIMARY KEY,
      product_version_id UUID NOT NULL REFERENCES insurance_product_versions(id) ON DELETE RESTRICT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      wording_sha256 TEXT NOT NULL,
      disclosure_sha256 TEXT NOT NULL,
      acceptance_text TEXT NOT NULL,
      acceptance_sha256 TEXT NOT NULL CHECK (acceptance_sha256 ~ '^[0-9a-f]{64}$'),
      authenticated_session_id TEXT NOT NULL REFERENCES auth_sessions(id) ON DELETE RESTRICT,
      accepted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE regulated_insurance_policies (
      id UUID PRIMARY KEY,
      acceptance_id UUID NOT NULL UNIQUE REFERENCES insurance_policy_acceptances(id) ON DELETE RESTRICT,
      state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending','cooling_off','active','grace','lapsed','cancelled','expired')),
      provider_policy_reference TEXT,
      cover_start_at TIMESTAMPTZ,
      cooling_off_ends_at TIMESTAMPTZ,
      grace_ends_at TIMESTAMPTZ,
      cancelled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE insurance_premium_collections (
      id UUID PRIMARY KEY,
      policy_id UUID NOT NULL REFERENCES regulated_insurance_policies(id) ON DELETE RESTRICT,
      amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
      period_start DATE NOT NULL,
      period_end DATE NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('authorized','collected','failed','reversed','settled')),
      collection_journal_id UUID UNIQUE REFERENCES journal_transactions(id) ON DELETE RESTRICT,
      provider_settlement_journal_id UUID UNIQUE REFERENCES journal_transactions(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE regulated_insurance_claims (
      id UUID PRIMARY KEY,
      policy_id UUID NOT NULL REFERENCES regulated_insurance_policies(id) ON DELETE RESTRICT,
      claimed_cents BIGINT NOT NULL CHECK (claimed_cents > 0),
      incident_type TEXT NOT NULL,
      incident_at TIMESTAMPTZ NOT NULL,
      state TEXT NOT NULL DEFAULT 'submitted'
        CHECK (state IN ('submitted','evidence_required','provider_review','approved',
                         'rejected','paid','withdrawn')),
      delegated_authority_reference TEXT,
      provider_decision_reference TEXT,
      payout_journal_id UUID UNIQUE REFERENCES journal_transactions(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CHECK (state NOT IN ('approved','paid') OR
             (delegated_authority_reference IS NOT NULL AND provider_decision_reference IS NOT NULL)),
      CHECK (state <> 'paid' OR payout_journal_id IS NOT NULL)
    );
    CREATE TABLE insurance_claim_evidence (
      id UUID PRIMARY KEY,
      claim_id UUID NOT NULL REFERENCES regulated_insurance_claims(id) ON DELETE RESTRICT,
      evidence_type TEXT NOT NULL,
      object_uri TEXT NOT NULL,
      object_sha256 TEXT NOT NULL CHECK (object_sha256 ~ '^[0-9a-f]{64}$'),
      submitted_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE insurance_communications (
      id UUID PRIMARY KEY,
      policy_id UUID REFERENCES regulated_insurance_policies(id) ON DELETE RESTRICT,
      claim_id UUID REFERENCES regulated_insurance_claims(id) ON DELETE RESTRICT,
      template_version TEXT NOT NULL,
      channel TEXT NOT NULL CHECK (channel IN ('sms','email','in_app','letter')),
      content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
      provider_reference TEXT,
      delivered_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CHECK (policy_id IS NOT NULL OR claim_id IS NOT NULL)
    );

    CREATE TABLE utility_catalogue_versions (
      id UUID PRIMARY KEY,
      endpoint_id UUID NOT NULL REFERENCES provider_endpoints(id) ON DELETE RESTRICT,
      provider_product_ref TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      category TEXT NOT NULL CHECK
        (category IN ('electricity','water','airtime','data')),
      name TEXT NOT NULL,
      cost_cents BIGINT NOT NULL CHECK (cost_cents >= 0),
      fee_cents BIGINT NOT NULL CHECK (fee_cents >= 0),
      min_cents BIGINT NOT NULL CHECK (min_cents > 0),
      max_cents BIGINT NOT NULL CHECK (max_cents >= min_cents),
      finality_disclosure TEXT NOT NULL,
      finality_sha256 TEXT NOT NULL CHECK (finality_sha256 ~ '^[0-9a-f]{64}$'),
      state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','published','retired')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE(endpoint_id,provider_product_ref,version)
    );
    ALTER TABLE utility_purchases
      ADD COLUMN catalogue_version_id UUID REFERENCES utility_catalogue_versions(id) ON DELETE RESTRICT,
      ADD COLUMN cost_cents BIGINT CHECK (cost_cents IS NULL OR cost_cents >= 0),
      ADD COLUMN fee_cents BIGINT CHECK (fee_cents IS NULL OR fee_cents >= 0),
      ADD COLUMN prefund_journal_id UUID REFERENCES journal_transactions(id) ON DELETE RESTRICT,
      ADD COLUMN reversal_journal_id UUID REFERENCES journal_transactions(id) ON DELETE RESTRICT,
      ADD COLUMN finality_disclosure_sha256 TEXT,
      ADD COLUMN delivery_state TEXT DEFAULT 'pending'
        CHECK (delivery_state IN ('pending','delivered','delivery_failed','recovery_pending','recovered'));
    CREATE TABLE utility_delivery_attempts (
      id UUID PRIMARY KEY,
      purchase_id TEXT NOT NULL REFERENCES utility_purchases(id) ON DELETE RESTRICT,
      attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
      channel TEXT NOT NULL CHECK (channel IN ('api','sms','in_app','support_recovery')),
      token_fingerprint TEXT,
      state TEXT NOT NULL CHECK (state IN ('delivered','failed','unknown','recovered')),
      error_code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE(purchase_id,attempt_number)
    );
    CREATE TABLE utility_provider_requeries (
      id UUID PRIMARY KEY,
      purchase_id TEXT NOT NULL REFERENCES utility_purchases(id) ON DELETE RESTRICT,
      provider_instruction_id UUID NOT NULL REFERENCES provider_instructions(id) ON DELETE RESTRICT,
      outcome TEXT NOT NULL CHECK (outcome IN ('fulfilled','failed','unknown')),
      response_sha256 TEXT NOT NULL CHECK (response_sha256 ~ '^[0-9a-f]{64}$'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE utility_prefund_reconciliations (
      id UUID PRIMARY KEY,
      endpoint_id UUID NOT NULL REFERENCES provider_endpoints(id) ON DELETE RESTRICT,
      statement_balance_cents BIGINT NOT NULL,
      ledger_balance_cents BIGINT NOT NULL,
      break_cents BIGINT NOT NULL,
      evidence JSONB NOT NULL,
      evidence_sha256 TEXT NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
      state TEXT NOT NULL CHECK (state IN ('passed','failed','investigating')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CHECK (break_cents = statement_balance_cents - ledger_balance_cents)
    );

    CREATE FUNCTION enforce_stokvel_withdrawal_approval() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE valid_approvals INTEGER;
      BEGIN
        IF NEW.state IN ('approved','posted') AND OLD.state NOT IN ('approved','posted') THEN
          SELECT count(*) INTO valid_approvals
            FROM stokvel_withdrawal_approvals a
            JOIN stokvel_memberships m ON m.id = a.membership_id
           WHERE a.withdrawal_request_id = NEW.id AND a.decision = 'approved'
             AND m.stokvel_account_id = NEW.stokvel_account_id
             AND m.state = 'active';
          IF valid_approvals < NEW.required_approvals THEN
            RAISE EXCEPTION 'insufficient distinct active-member approvals';
          END IF;
        END IF;
        IF NEW.state = 'posted' AND NEW.journal_transaction_id IS NULL THEN
          RAISE EXCEPTION 'posted withdrawal requires a journal transaction';
        END IF;
        RETURN NEW;
      END $$;
    CREATE TRIGGER stokvel_withdrawal_threshold
      BEFORE UPDATE ON stokvel_withdrawal_requests
      FOR EACH ROW EXECUTE FUNCTION enforce_stokvel_withdrawal_approval();

    CREATE FUNCTION enforce_loan_maker_checker() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE approval UUID;
      DECLARE expected_action TEXT;
      BEGIN
        IF NEW.state = 'active' AND OLD.state = 'pending_disbursement' THEN
          approval := NEW.disbursement_approval_id;
          expected_action := 'loan_disbursement';
          IF NEW.disbursement_journal_id IS NULL THEN
            RAISE EXCEPTION 'loan disbursement requires a posted journal';
          END IF;
        ELSIF NEW.state = 'written_off' AND OLD.state <> 'written_off' THEN
          approval := NEW.write_off_approval_id;
          expected_action := 'loan_write_off';
        ELSE
          RETURN NEW;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM approval_requests a
           WHERE a.id = approval AND a.action_type = expected_action
             AND a.resource_type = 'loan' AND a.resource_id = NEW.id::text
             AND a.state = 'approved' AND a.expires_at > clock_timestamp()
             AND a.checker_operator_id IS NOT NULL
             AND a.checker_operator_id <> a.maker_operator_id
        ) THEN
          RAISE EXCEPTION 'current maker-checker approval is required';
        END IF;
        RETURN NEW;
      END $$;
    CREATE TRIGGER loan_maker_checker
      BEFORE UPDATE ON regulated_loans
      FOR EACH ROW EXECUTE FUNCTION enforce_loan_maker_checker();

    CREATE TRIGGER product_readiness_evidence_immutable
      BEFORE UPDATE OR DELETE ON product_readiness_evidence
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
    CREATE TRIGGER product_readiness_checks_immutable
      BEFORE UPDATE OR DELETE ON product_readiness_checks
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
    CREATE TRIGGER product_reconciliation_runs_immutable
      BEFORE UPDATE OR DELETE ON product_reconciliation_runs
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
    CREATE TRIGGER product_failure_tests_immutable
      BEFORE UPDATE OR DELETE ON product_failure_test_runs
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
    CREATE TRIGGER stokvel_constitutions_immutable
      BEFORE UPDATE OR DELETE ON stokvel_constitution_versions
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
    CREATE TRIGGER stokvel_consents_immutable
      BEFORE UPDATE OR DELETE ON stokvel_member_consents
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
    CREATE TRIGGER stokvel_contributions_immutable
      BEFORE UPDATE OR DELETE ON stokvel_contribution_records
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
    CREATE TRIGGER stokvel_withdrawal_approvals_immutable
      BEFORE UPDATE OR DELETE ON stokvel_withdrawal_approvals
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
    CREATE TRIGGER stokvel_state_events_immutable
      BEFORE UPDATE OR DELETE ON stokvel_state_events
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
    CREATE TRIGGER stokvel_conversion_immutable
      BEFORE DELETE ON stokvel_legacy_conversion
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
    CREATE TRIGGER lending_products_immutable
      BEFORE UPDATE OR DELETE ON lending_product_versions
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
    CREATE TRIGGER lending_assessments_immutable
      BEFORE UPDATE OR DELETE ON lending_affordability_assessments
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
    CREATE TRIGGER lending_agreements_immutable
      BEFORE UPDATE OR DELETE ON lending_agreements
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
    CREATE TRIGGER loan_schedules_immutable
      BEFORE UPDATE OR DELETE ON loan_schedule_items
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
    CREATE TRIGGER loan_repayments_immutable
      BEFORE UPDATE OR DELETE ON loan_repayments
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
    CREATE TRIGGER loan_allocations_immutable
      BEFORE UPDATE OR DELETE ON loan_repayment_allocations
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
    CREATE TRIGGER loan_state_events_immutable
      BEFORE UPDATE OR DELETE ON loan_state_events
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
    CREATE TRIGGER credit_terms_immutable
      BEFORE UPDATE OR DELETE ON merchant_credit_term_versions
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
    CREATE TRIGGER credit_consents_immutable
      BEFORE UPDATE OR DELETE ON merchant_credit_consents
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
    CREATE TRIGGER credit_events_immutable
      BEFORE UPDATE OR DELETE ON merchant_credit_events
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
    CREATE TRIGGER credit_allocations_immutable
      BEFORE UPDATE OR DELETE ON merchant_credit_allocations
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
    CREATE TRIGGER insurance_products_immutable
      BEFORE UPDATE OR DELETE ON insurance_product_versions
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
    CREATE TRIGGER insurance_acceptances_immutable
      BEFORE UPDATE OR DELETE ON insurance_policy_acceptances
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
    CREATE TRIGGER insurance_claim_evidence_immutable
      BEFORE UPDATE OR DELETE ON insurance_claim_evidence
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
    CREATE TRIGGER insurance_communications_immutable
      BEFORE UPDATE OR DELETE ON insurance_communications
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
    CREATE TRIGGER utility_catalogue_immutable
      BEFORE UPDATE OR DELETE ON utility_catalogue_versions
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
    CREATE TRIGGER utility_delivery_attempts_immutable
      BEFORE UPDATE OR DELETE ON utility_delivery_attempts
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
    CREATE TRIGGER utility_requeries_immutable
      BEFORE UPDATE OR DELETE ON utility_provider_requeries
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
    CREATE TRIGGER utility_prefund_recon_immutable
      BEFORE UPDATE OR DELETE ON utility_prefund_reconciliations
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();
  `);
};

export const down = false;
