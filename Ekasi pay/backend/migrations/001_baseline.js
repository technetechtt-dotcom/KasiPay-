/** Baseline schema extracted from the former startup bootstrap. */
export const up = (pgm) => {
  pgm.sql(String.raw`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      pin_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      kyc_status TEXT NOT NULL DEFAULT 'pending',
      account_tier TEXT NOT NULL DEFAULT 'Basic',
      created_at TIMESTAMPTZ NOT NULL,
      country_code TEXT NOT NULL DEFAULT 'ZA',
      is_system INTEGER NOT NULL DEFAULT 0,
      deleted_at TIMESTAMPTZ,
      suspended_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS merchants (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      business_name TEXT NOT NULL,
      location TEXT NOT NULL,
      category TEXT NOT NULL,
      approval_status TEXT NOT NULL DEFAULT 'pending_docs',
      rejection_reason TEXT,
      reviewed_at TIMESTAMPTZ,
      reviewed_by TEXT,
      docs_submitted_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS merchant_documents (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      doc_type TEXT NOT NULL,
      file_name TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      file_data BYTEA NOT NULL,
      uploaded_at TIMESTAMPTZ NOT NULL,
      UNIQUE (merchant_id, doc_type)
    );
    CREATE INDEX IF NOT EXISTS idx_merchant_documents_merchant
      ON merchant_documents(merchant_id);

    CREATE TABLE IF NOT EXISTS wallets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      balance DOUBLE PRECISION NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'ZAR',
      status TEXT NOT NULL DEFAULT 'active',
      pool_id TEXT NOT NULL DEFAULT 'ZA',
      wallet_kind TEXT NOT NULL DEFAULT 'user'
    );
    CREATE INDEX IF NOT EXISTS idx_wallets_user_kind ON wallets(user_id, wallet_kind);

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      cost_price DOUBLE PRECISION NOT NULL,
      price DOUBLE PRECISION NOT NULL,
      stock INTEGER NOT NULL,
      category TEXT NOT NULL,
      barcode TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_products_merchant_name ON products(merchant_id, name);

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      from_wallet_id TEXT REFERENCES wallets(id),
      to_wallet_id TEXT REFERENCES wallets(id),
      amount DOUBLE PRECISION NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      reference TEXT NOT NULL,
      description TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(created_at DESC);

    CREATE TABLE IF NOT EXISTS ledger_entries (
      id TEXT PRIMARY KEY,
      transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES wallets(id),
      entry_type TEXT NOT NULL,
      amount DOUBLE PRECISION NOT NULL,
      balance_after DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_entries_txn ON ledger_entries(transaction_id);

    CREATE TABLE IF NOT EXISTS sales (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      items_json TEXT NOT NULL,
      total DOUBLE PRECISION NOT NULL,
      payment_method TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sales_merchant_created ON sales(merchant_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      amount DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_expenses_merchant_created ON expenses(merchant_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS credit_customers (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      total_owed DOUBLE PRECISION NOT NULL DEFAULT 0,
      credit_limit DOUBLE PRECISION NOT NULL,
      last_payment_date TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_credit_customers_merchant_name ON credit_customers(merchant_id, name);

    CREATE TABLE IF NOT EXISTS credit_transactions (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL REFERENCES credit_customers(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      amount DOUBLE PRECISION NOT NULL,
      description TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_credit_txn_customer_created ON credit_transactions(customer_id, created_at DESC);

    ALTER TABLE credit_customers ADD COLUMN IF NOT EXISTS sa_id_hash TEXT;
    ALTER TABLE credit_customers ADD COLUMN IF NOT EXISTS id_verified_at TIMESTAMPTZ;

    ALTER TABLE merchants ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'pending_docs';
    ALTER TABLE merchants ALTER COLUMN approval_status SET DEFAULT 'pending_docs';
    ALTER TABLE merchants ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
    ALTER TABLE merchants ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
    ALTER TABLE merchants ADD COLUMN IF NOT EXISTS reviewed_by TEXT;
    ALTER TABLE merchants ADD COLUMN IF NOT EXISTS docs_submitted_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS credit_otp_codes (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      phone TEXT NOT NULL,
      purpose TEXT NOT NULL,
      customer_id TEXT REFERENCES credit_customers(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      sa_id_hash TEXT,
      verification_token TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      verification_expires_at TIMESTAMPTZ,
      used_at TIMESTAMPTZ,
      token_used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_credit_otp_merchant_phone
      ON credit_otp_codes(merchant_id, phone, purpose);
    CREATE INDEX IF NOT EXISTS idx_credit_otp_token
      ON credit_otp_codes(verification_token);

    CREATE TABLE IF NOT EXISTS compliance_flags (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      transaction_id TEXT,
      reason TEXT NOT NULL,
      severity TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS idempotency_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      route TEXT NOT NULL,
      client_key TEXT NOT NULL,
      status INTEGER NOT NULL,
      response_body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_idem_user_route_key
      ON idempotency_keys(user_id, route, client_key);
    CREATE INDEX IF NOT EXISTS idx_idem_created ON idempotency_keys(created_at DESC);

    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      refresh_token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      absolute_expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);

    CREATE TABLE IF NOT EXISTS pin_login_failures (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TIMESTAMPTZ,
      last_attempt_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cash_send_collect_failures (
      reference_number TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TIMESTAMPTZ,
      last_attempt_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pin_reset_codes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pin_reset_user ON pin_reset_codes(user_id);

    CREATE TABLE IF NOT EXISTS suppliers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      category TEXT NOT NULL,
      delivery_days_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS supplier_orders (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      supplier_id TEXT NOT NULL REFERENCES suppliers(id),
      items_json TEXT NOT NULL,
      total DOUBLE PRECISION NOT NULL,
      status TEXT NOT NULL,
      order_date TIMESTAMPTZ NOT NULL,
      expected_delivery TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_supplier_orders_merchant
      ON supplier_orders(merchant_id, order_date DESC);

    CREATE TABLE IF NOT EXISTS supplier_verifications (
      supplier_id TEXT PRIMARY KEY REFERENCES suppliers(id) ON DELETE CASCADE,
      cipc_registered INTEGER NOT NULL DEFAULT 0,
      health_dept_approved INTEGER NOT NULL DEFAULT 0,
      last_inspection_date TEXT NOT NULL,
      certificate_expiry TEXT NOT NULL,
      verification_status TEXT NOT NULL,
      risk_level TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stokvel_groups (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      members_json TEXT NOT NULL,
      target_amount DOUBLE PRECISION NOT NULL,
      current_amount DOUBLE PRECISION NOT NULL,
      frequency TEXT NOT NULL,
      next_payout_date TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stokvel_loans (
      id TEXT PRIMARY KEY,
      stokvel_id TEXT NOT NULL REFERENCES stokvel_groups(id) ON DELETE CASCADE,
      lender_name TEXT NOT NULL,
      lender_phone TEXT NOT NULL,
      borrower_name TEXT NOT NULL,
      borrower_phone TEXT NOT NULL,
      amount DOUBLE PRECISION NOT NULL,
      interest_rate_percent DOUBLE PRECISION NOT NULL,
      interest_amount DOUBLE PRECISION NOT NULL,
      total_due DOUBLE PRECISION NOT NULL,
      from_pool BOOLEAN NOT NULL DEFAULT FALSE,
      status TEXT NOT NULL,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      repaid_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_stokvel_loans_group ON stokvel_loans(stokvel_id);

    CREATE TABLE IF NOT EXISTS stokvel_contributions (
      id TEXT PRIMARY KEY,
      stokvel_id TEXT NOT NULL REFERENCES stokvel_groups(id) ON DELETE CASCADE,
      member_name TEXT NOT NULL,
      member_phone TEXT NOT NULL,
      amount DOUBLE PRECISION NOT NULL,
      period_month TEXT NOT NULL,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_stokvel_contrib_group ON stokvel_contributions(stokvel_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_stokvel_contrib_member_period
      ON stokvel_contributions(stokvel_id, member_phone, period_month);

    CREATE TABLE IF NOT EXISTS layby_orders (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      item_name TEXT NOT NULL,
      total_price DOUBLE PRECISION NOT NULL,
      amount_paid DOUBLE PRECISION NOT NULL,
      installments_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS load_shedding_slots (
      id TEXT PRIMARY KEY,
      stage INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      area TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS loans (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount DOUBLE PRECISION NOT NULL,
      interest_rate DOUBLE PRECISION NOT NULL,
      status TEXT NOT NULL,
      disbursed_at TIMESTAMPTZ,
      due_date TIMESTAMPTZ,
      repaid_amount DOUBLE PRECISION NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS price_comparisons (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      product_name TEXT NOT NULL,
      my_price DOUBLE PRECISION NOT NULL,
      avg_area_price DOUBLE PRECISION NOT NULL,
      lowest_area_price DOUBLE PRECISION NOT NULL,
      highest_area_price DOUBLE PRECISION NOT NULL,
      competitors INTEGER NOT NULL,
      last_updated TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS insurance_policies (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      type TEXT NOT NULL,
      coverage_amount DOUBLE PRECISION NOT NULL,
      monthly_premium DOUBLE PRECISION NOT NULL,
      status TEXT NOT NULL,
      next_payment_date TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS insurance_claims (
      id TEXT PRIMARY KEY,
      policy_id TEXT NOT NULL REFERENCES insurance_policies(id) ON DELETE CASCADE,
      merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      claimed_amount DOUBLE PRECISION NOT NULL,
      status TEXT NOT NULL DEFAULT 'submitted',
      created_at TIMESTAMPTZ NOT NULL,
      reviewed_at TIMESTAMPTZ,
      reviewed_by TEXT REFERENCES users(id),
      admin_note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_claims_policy ON insurance_claims(policy_id);

    CREATE TABLE IF NOT EXISTS voice_notes (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      transcript TEXT NOT NULL,
      duration DOUBLE PRECISION NOT NULL DEFAULT 0,
      category TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS expiry_items (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      product_name TEXT NOT NULL,
      category TEXT NOT NULL,
      batch_number TEXT NOT NULL,
      expiry_date TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      supplier_id TEXT NOT NULL,
      status TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS food_safety_alerts (
      id TEXT PRIMARY KEY,
      merchant_id TEXT REFERENCES merchants(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      severity TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS cash_send_vouchers (
      id TEXT PRIMARY KEY,
      sender_user_id TEXT NOT NULL REFERENCES users(id),
      sender_phone TEXT NOT NULL,
      sender_name TEXT,
      sender_first_name TEXT NOT NULL DEFAULT '',
      sender_last_name TEXT NOT NULL DEFAULT '',
      sender_id_document TEXT NOT NULL DEFAULT '',
      sender_address TEXT NOT NULL DEFAULT '',
      recipient_phone TEXT NOT NULL,
      recipient_name TEXT,
      recipient_first_name TEXT NOT NULL DEFAULT '',
      recipient_last_name TEXT NOT NULL DEFAULT '',
      recipient_id_document TEXT NOT NULL DEFAULT '',
      amount DOUBLE PRECISION NOT NULL,
      fee DOUBLE PRECISION NOT NULL,
      pin_hash TEXT NOT NULL,
      reference_number TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      collected_at TIMESTAMPTZ,
      cancel_reason TEXT,
      collector_scanned_id TEXT,
      collected_with_id_verified INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_cash_send_sender
      ON cash_send_vouchers(sender_user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS stock_movements (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      type TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      reason TEXT NOT NULL,
      cost_price_at_time DOUBLE PRECISION,
      reference TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS purchase_slips (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      supplier_name TEXT,
      slip_reference TEXT,
      total DOUBLE PRECISION NOT NULL,
      line_items_json TEXT NOT NULL,
      notes TEXT,
      expense_id TEXT,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ops_admin_users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      last_login_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at DESC);

    CREATE TABLE IF NOT EXISTS commission_postings (
      id TEXT PRIMARY KEY,
      agent_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      amount DOUBLE PRECISION NOT NULL,
      description TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_commission_agent
      ON commission_postings(agent_user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS utility_purchases (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      provider TEXT NOT NULL,
      beneficiary TEXT NOT NULL,
      amount DOUBLE PRECISION NOT NULL,
      reference TEXT NOT NULL,
      voucher_code TEXT,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_utility_user_created
      ON utility_purchases(user_id, created_at DESC);

    INSERT INTO users (
      id, name, phone, pin_hash, role, kyc_status, account_tier, created_at,
      country_code, is_system
    ) VALUES (
      'kasipay-system-escrow-za',
      'KasiPay network float (ZA)',
      '__kp_escrow_ZA_v1',
      '$2a$12$mO963One1uAt6r.jFOVtA.OAMTm7jmjQz4ocT760bCJIUeAYLLwpu',
      'customer', 'verified', 'System', NOW(), 'ZA', 1
    ) ON CONFLICT (id) DO NOTHING;

    INSERT INTO wallets (
      id, user_id, balance, currency, status, pool_id, wallet_kind
    ) SELECT
      'kasipay-system-escrow-wallet-za',
      'kasipay-system-escrow-za',
      0, 'ZAR', 'active', 'ZA', 'system_escrow'
    WHERE NOT EXISTS (
      SELECT 1 FROM wallets
      WHERE user_id = 'kasipay-system-escrow-za'
         OR (wallet_kind = 'system_escrow' AND pool_id = 'ZA')
    )
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO suppliers (id, name, phone, category, delivery_days_json)
    SELECT *
    FROM (VALUES
      ('baseline-supplier-wholesale', 'Wholesale National', '0860000000',
       'Dry goods', '["Mon","Wed","Fri"]'),
      ('baseline-supplier-produce', 'Fresh Produce Co.', '0115551234',
       'Produce', '["Tue","Thu"]')
    ) AS defaults(id, name, phone, category, delivery_days_json)
    WHERE NOT EXISTS (SELECT 1 FROM suppliers)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO load_shedding_slots (id, stage, start_time, end_time, area)
    SELECT *
    FROM (VALUES
      ('baseline-load-slot-1', 2, '08:00', '10:00', 'Ekurhuleni Block 4'),
      ('baseline-load-slot-2', 4, '18:00', '20:30', 'Ekurhuleni Block 4'),
      ('baseline-load-slot-3', 1, '12:00', '14:00', 'Johannesburg City')
    ) AS defaults(id, stage, start_time, end_time, area)
    WHERE NOT EXISTS (SELECT 1 FROM load_shedding_slots)
    ON CONFLICT (id) DO NOTHING;
  `);
};

// Baselines are intentionally irreversible; use backups for recovery.
export const down = false;
