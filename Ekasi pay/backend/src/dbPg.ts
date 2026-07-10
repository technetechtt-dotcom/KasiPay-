import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';

import { DATABASE_URL } from './config.js';
import { pgPoolSsl } from './pgSsl.js';
import { seedEscrowPoolZaPg } from './services/escrowPg.js';

let pool: Pool | null = null;

function ensurePool(): Pool {
  if (pool) return pool;
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL is required for Postgres mode.');
  }
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: pgPoolSsl(DATABASE_URL),
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  return pool;
}

async function bootstrapSchema(p: Pool): Promise<void> {
  await p.query(`
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
      approval_status TEXT NOT NULL DEFAULT 'approved',
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

    ALTER TABLE merchants ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'approved';
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
  `);
}

async function seedDefaultsPg(p: Pool): Promise<void> {
  const sc = await p.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM suppliers`,
  );
  if (Number(sc.rows[0]?.c ?? 0) === 0) {
    await p.query(
      `INSERT INTO suppliers (id, name, phone, category, delivery_days_json)
       VALUES ($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10)`,
      [
        randomUUID(),
        'Wholesale National',
        '0860000000',
        'Dry goods',
        JSON.stringify(['Mon', 'Wed', 'Fri']),
        randomUUID(),
        'Fresh Produce Co.',
        '0115551234',
        'Produce',
        JSON.stringify(['Tue', 'Thu']),
      ],
    );
  }

  const lc = await p.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM load_shedding_slots`,
  );
  if (Number(lc.rows[0]?.c ?? 0) === 0) {
    await p.query(
      `INSERT INTO load_shedding_slots (id, stage, start_time, end_time, area)
       VALUES ($1, 2, '08:00', '10:00', 'Ekurhuleni Block 4'),
              ($2, 4, '18:00', '20:30', 'Ekurhuleni Block 4'),
              ($3, 1, '12:00', '14:00', 'Johannesburg City')`,
      [randomUUID(), randomUUID(), randomUUID()],
    );
  }
}

export async function initPg(): Promise<void> {
  const p = ensurePool();
  await bootstrapSchema(p);
  await seedEscrowPoolZaPg(p);
  await seedDefaultsPg(p);
}

export function getPgPool(): Pool {
  return ensurePool();
}

export async function closePg(): Promise<void> {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}
