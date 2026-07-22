import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';

import { DATABASE_PATH } from './config.js';
import { hashPin } from './password.js';
import {
  currencyForPool,
  DEFAULT_POOL_ID,
  ESCROW_SYSTEM_USER_ID_ZA,
  ESCROW_SYSTEM_USER_PHONE_ZA,
} from './poolConstants.js';

let db: Database.Database | null = null;

function migrate(database: Database.Database) {
  database.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      pin_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      kyc_status TEXT NOT NULL DEFAULT 'pending',
      account_tier TEXT NOT NULL DEFAULT 'Basic',
      created_at TEXT NOT NULL,
      country_code TEXT NOT NULL DEFAULT 'ZA',
      is_system INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS merchants (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      business_name TEXT NOT NULL,
      location TEXT NOT NULL,
      category TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS wallets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      balance REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'ZAR',
      status TEXT NOT NULL DEFAULT 'active',
      pool_id TEXT NOT NULL DEFAULT 'ZA',
      wallet_kind TEXT NOT NULL DEFAULT 'user',
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      cost_price REAL NOT NULL,
      price REAL NOT NULL,
      stock INTEGER NOT NULL,
      category TEXT NOT NULL,
      barcode TEXT,
      FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sales (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL,
      items_json TEXT NOT NULL,
      total REAL NOT NULL,
      payment_method TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      from_wallet_id TEXT,
      to_wallet_id TEXT,
      amount REAL NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      reference TEXT NOT NULL,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (from_wallet_id) REFERENCES wallets (id),
      FOREIGN KEY (to_wallet_id) REFERENCES wallets (id)
    );

    CREATE TABLE IF NOT EXISTS ledger_entries (
      id TEXT PRIMARY KEY,
      transaction_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      entry_type TEXT NOT NULL,
      amount REAL NOT NULL,
      balance_after REAL NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (transaction_id) REFERENCES transactions (id) ON DELETE CASCADE,
      FOREIGN KEY (account_id) REFERENCES wallets (id)
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      amount REAL NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS credit_customers (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      total_owed REAL NOT NULL DEFAULT 0,
      credit_limit REAL NOT NULL,
      last_payment_date TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS credit_transactions (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (customer_id) REFERENCES credit_customers (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS suppliers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      category TEXT NOT NULL,
      delivery_days_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS supplier_orders (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL,
      supplier_id TEXT NOT NULL,
      items_json TEXT NOT NULL,
      total REAL NOT NULL,
      status TEXT NOT NULL,
      order_date TEXT NOT NULL,
      expected_delivery TEXT,
      FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE,
      FOREIGN KEY (supplier_id) REFERENCES suppliers (id)
    );

    CREATE TABLE IF NOT EXISTS supplier_verifications (
      supplier_id TEXT PRIMARY KEY,
      cipc_registered INTEGER NOT NULL DEFAULT 0,
      health_dept_approved INTEGER NOT NULL DEFAULT 0,
      last_inspection_date TEXT NOT NULL,
      certificate_expiry TEXT NOT NULL,
      verification_status TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      FOREIGN KEY (supplier_id) REFERENCES suppliers (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS stokvel_groups (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      members_json TEXT NOT NULL,
      target_amount REAL NOT NULL,
      current_amount REAL NOT NULL,
      frequency TEXT NOT NULL,
      next_payout_date TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS stokvel_loans (
      id TEXT PRIMARY KEY,
      stokvel_id TEXT NOT NULL,
      lender_name TEXT NOT NULL,
      lender_phone TEXT NOT NULL,
      borrower_name TEXT NOT NULL,
      borrower_phone TEXT NOT NULL,
      amount REAL NOT NULL,
      interest_rate_percent REAL NOT NULL,
      interest_amount REAL NOT NULL,
      total_due REAL NOT NULL,
      from_pool INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL,
      repaid_at TEXT,
      FOREIGN KEY (stokvel_id) REFERENCES stokvel_groups (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS stokvel_contributions (
      id TEXT PRIMARY KEY,
      stokvel_id TEXT NOT NULL,
      member_name TEXT NOT NULL,
      member_phone TEXT NOT NULL,
      amount REAL NOT NULL,
      period_month TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (stokvel_id) REFERENCES stokvel_groups (id) ON DELETE CASCADE,
      UNIQUE (stokvel_id, member_phone, period_month)
    );

    CREATE TABLE IF NOT EXISTS layby_orders (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      item_name TEXT NOT NULL,
      total_price REAL NOT NULL,
      amount_paid REAL NOT NULL,
      installments_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE
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
      user_id TEXT NOT NULL,
      amount REAL NOT NULL,
      interest_rate REAL NOT NULL,
      status TEXT NOT NULL,
      disbursed_at TEXT,
      due_date TEXT,
      repaid_amount REAL NOT NULL DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS compliance_flags (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      transaction_id TEXT,
      reason TEXT NOT NULL,
      severity TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS price_comparisons (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      my_price REAL NOT NULL,
      avg_area_price REAL NOT NULL,
      lowest_area_price REAL NOT NULL,
      highest_area_price REAL NOT NULL,
      competitors INTEGER NOT NULL,
      last_updated TEXT NOT NULL,
      FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS insurance_policies (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      type TEXT NOT NULL,
      coverage_amount REAL NOT NULL,
      monthly_premium REAL NOT NULL,
      status TEXT NOT NULL,
      next_payment_date TEXT NOT NULL,
      FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS voice_notes (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL,
      title TEXT NOT NULL,
      transcript TEXT NOT NULL,
      duration REAL NOT NULL DEFAULT 0,
      category TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS expiry_items (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      category TEXT NOT NULL,
      batch_number TEXT NOT NULL,
      expiry_date TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      supplier_id TEXT NOT NULL,
      status TEXT NOT NULL,
      FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS food_safety_alerts (
      id TEXT PRIMARY KEY,
      merchant_id TEXT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      severity TEXT NOT NULL,
      created_at TEXT NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS cash_send_vouchers (
      id TEXT PRIMARY KEY,
      sender_user_id TEXT NOT NULL,
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
      amount REAL NOT NULL,
      fee REAL NOT NULL,
      pin_hash TEXT NOT NULL,
      reference_number TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      collected_at TEXT,
      cancel_reason TEXT,
      collector_scanned_id TEXT,
      collected_with_id_verified INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (sender_user_id) REFERENCES users (id)
    );

    CREATE TABLE IF NOT EXISTS stock_movements (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      type TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      reason TEXT NOT NULL,
      cost_price_at_time REAL,
      reference TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS purchase_slips (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL,
      supplier_name TEXT,
      slip_reference TEXT,
      total REAL NOT NULL,
      line_items_json TEXT NOT NULL,
      notes TEXT,
      expense_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      actor_user_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL
    );
  `);
}

function applyIncrementalMigrations(database: Database.Database) {
  const userCols = new Set(
    (
      database.prepare('PRAGMA table_info(users)').all() as { name: string }[]
    ).map((c) => c.name)
  );
  if (!userCols.has('country_code')) {
    database.exec(
      `ALTER TABLE users ADD COLUMN country_code TEXT NOT NULL DEFAULT 'ZA'`
    );
  }
  if (!userCols.has('is_system')) {
    database.exec(
      `ALTER TABLE users ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0`
    );
  }
  const walletCols = new Set(
    (
      database.prepare('PRAGMA table_info(wallets)').all() as { name: string }[]
    ).map((c) => c.name)
  );
  if (!walletCols.has('pool_id')) {
    database.exec(
      `ALTER TABLE wallets ADD COLUMN pool_id TEXT NOT NULL DEFAULT 'ZA'`
    );
  }
  if (!walletCols.has('wallet_kind')) {
    database.exec(
      `ALTER TABLE wallets ADD COLUMN wallet_kind TEXT NOT NULL DEFAULT 'user'`
    );
  }

  const voucherCols = new Set(
    (
      database.prepare('PRAGMA table_info(cash_send_vouchers)').all() as {
        name: string;
      }[]
    ).map((c) => c.name)
  );
  const voucherColumnAdds: { name: string; ddl: string }[] = [
    { name: 'sender_first_name', ddl: "TEXT NOT NULL DEFAULT ''" },
    { name: 'sender_last_name', ddl: "TEXT NOT NULL DEFAULT ''" },
    { name: 'sender_id_document', ddl: "TEXT NOT NULL DEFAULT ''" },
    { name: 'sender_address', ddl: "TEXT NOT NULL DEFAULT ''" },
    { name: 'recipient_first_name', ddl: "TEXT NOT NULL DEFAULT ''" },
    { name: 'recipient_last_name', ddl: "TEXT NOT NULL DEFAULT ''" },
    { name: 'recipient_id_document', ddl: "TEXT NOT NULL DEFAULT ''" },
    { name: 'collector_scanned_id', ddl: 'TEXT' },
    { name: 'collected_with_id_verified', ddl: 'INTEGER NOT NULL DEFAULT 0' },
  ];
  for (const { name: col, ddl } of voucherColumnAdds) {
    if (!voucherCols.has(col)) {
      database.exec(`ALTER TABLE cash_send_vouchers ADD COLUMN ${col} ${ddl}`);
    }
  }

  const sessionsTable = database
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='auth_sessions'`
    )
    .get() as { name: string } | undefined;
  if (!sessionsTable) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS auth_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        refresh_token_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        absolute_expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_sessions_refresh_hash ON auth_sessions(refresh_token_hash);
    `);
  } else {
    const sessionCols = new Set(
      (
        database.prepare('PRAGMA table_info(auth_sessions)').all() as {
          name: string;
        }[]
      ).map((c) => c.name),
    );
    if (!sessionCols.has('absolute_expires_at')) {
      // Existing rows: treat absolute_expires_at as the original expires_at
      // (the sliding window). That means active users will need to re-auth
      // when their current expires_at lapses — fine for a one-time migration.
      database.exec(
        `ALTER TABLE auth_sessions ADD COLUMN absolute_expires_at TEXT`,
      );
      database.exec(
        `UPDATE auth_sessions SET absolute_expires_at = expires_at WHERE absolute_expires_at IS NULL`,
      );
    }
  }

  const pinFailures = database
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='pin_login_failures'`,
    )
    .get() as { name: string } | undefined;
  if (!pinFailures) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS pin_login_failures (
        user_id TEXT PRIMARY KEY,
        attempts INTEGER NOT NULL DEFAULT 0,
        locked_until TEXT,
        last_attempt_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      );
    `);
  }

  const collectFailures = database
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='cash_send_collect_failures'`,
    )
    .get() as { name: string } | undefined;
  if (!collectFailures) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS cash_send_collect_failures (
        reference_number TEXT PRIMARY KEY,
        attempts INTEGER NOT NULL DEFAULT 0,
        locked_until TEXT,
        last_attempt_at TEXT NOT NULL
      );
    `);
  }

  const pinResets = database
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='pin_reset_codes'`,
    )
    .get() as { name: string } | undefined;
  if (!pinResets) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS pin_reset_codes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_pin_reset_user ON pin_reset_codes(user_id);
    `);
  }

  const usersCols2 = new Set(
    (
      database.prepare('PRAGMA table_info(users)').all() as { name: string }[]
    ).map((c) => c.name),
  );
  if (!usersCols2.has('deleted_at')) {
    database.exec(`ALTER TABLE users ADD COLUMN deleted_at TEXT`);
  }
  if (!usersCols2.has('suspended_at')) {
    database.exec(`ALTER TABLE users ADD COLUMN suspended_at TEXT`);
  }

  const claimsTable = database
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='insurance_claims'`,
    )
    .get() as { name: string } | undefined;
  if (!claimsTable) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS insurance_claims (
        id TEXT PRIMARY KEY,
        policy_id TEXT NOT NULL,
        merchant_id TEXT NOT NULL,
        type TEXT NOT NULL,
        description TEXT NOT NULL,
        claimed_amount REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'submitted',
        created_at TEXT NOT NULL,
        FOREIGN KEY (policy_id) REFERENCES insurance_policies (id) ON DELETE CASCADE,
        FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_claims_policy ON insurance_claims(policy_id);
    `);
  }

  const claimsCols = new Set(
    (
      database.prepare('PRAGMA table_info(insurance_claims)').all() as {
        name: string;
      }[]
    ).map((c) => c.name),
  );
  if (!claimsCols.has('reviewed_at')) {
    database.exec(`ALTER TABLE insurance_claims ADD COLUMN reviewed_at TEXT`);
  }
  if (!claimsCols.has('reviewed_by')) {
    database.exec(`ALTER TABLE insurance_claims ADD COLUMN reviewed_by TEXT`);
  }
  if (!claimsCols.has('admin_note')) {
    database.exec(`ALTER TABLE insurance_claims ADD COLUMN admin_note TEXT`);
  }

  const commissionsTable = database
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='commission_postings'`,
    )
    .get() as { name: string } | undefined;
  if (!commissionsTable) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS commission_postings (
        id TEXT PRIMARY KEY,
        agent_user_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        amount REAL NOT NULL,
        description TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (agent_user_id) REFERENCES users (id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_commission_agent ON commission_postings(agent_user_id);
    `);
  }

  // Idempotency cache for hot money-movement and ledger-creating POSTs.
  // We key on (user, route, client-supplied key) and cache the response status
  // + JSON body for up to 24 hours. Replays return the cached response.
  database.exec(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      route TEXT NOT NULL,
      client_key TEXT NOT NULL,
      status INTEGER NOT NULL,
      response_body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_idem_user_route_key
      ON idempotency_keys(user_id, route, client_key);
    CREATE INDEX IF NOT EXISTS idx_idem_created
      ON idempotency_keys(created_at);
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      actor_user_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at);
  `);

  const creditCols = new Set(
    (
      database.prepare('PRAGMA table_info(credit_customers)').all() as {
        name: string;
      }[]
    ).map((c) => c.name),
  );
  if (!creditCols.has('sa_id_hash')) {
    database.exec(`ALTER TABLE credit_customers ADD COLUMN sa_id_hash TEXT`);
  }
  if (!creditCols.has('id_verified_at')) {
    database.exec(`ALTER TABLE credit_customers ADD COLUMN id_verified_at TEXT`);
  }

  const merchantCols = new Set(
    (
      database.prepare('PRAGMA table_info(merchants)').all() as {
        name: string;
      }[]
    ).map((c) => c.name),
  );
  if (!merchantCols.has('approval_status')) {
    database.exec(
      `ALTER TABLE merchants ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'pending_docs'`,
    );
  }
  if (!merchantCols.has('rejection_reason')) {
    database.exec(`ALTER TABLE merchants ADD COLUMN rejection_reason TEXT`);
  }
  if (!merchantCols.has('reviewed_at')) {
    database.exec(`ALTER TABLE merchants ADD COLUMN reviewed_at TEXT`);
  }
  if (!merchantCols.has('reviewed_by')) {
    database.exec(`ALTER TABLE merchants ADD COLUMN reviewed_by TEXT`);
  }
  if (!merchantCols.has('docs_submitted_at')) {
    database.exec(`ALTER TABLE merchants ADD COLUMN docs_submitted_at TEXT`);
  }

  const merchantDocs = database
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='merchant_documents'`,
    )
    .get() as { name: string } | undefined;
  if (!merchantDocs) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS merchant_documents (
        id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL,
        doc_type TEXT NOT NULL,
        file_name TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        file_data BLOB NOT NULL,
        uploaded_at TEXT NOT NULL,
        UNIQUE (merchant_id, doc_type),
        FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_merchant_documents_merchant
        ON merchant_documents(merchant_id);
    `);
  }

  const creditOtp = database
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='credit_otp_codes'`,
    )
    .get() as { name: string } | undefined;
  if (!creditOtp) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS credit_otp_codes (
        id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL,
        phone TEXT NOT NULL,
        purpose TEXT NOT NULL,
        customer_id TEXT,
        code_hash TEXT NOT NULL,
        sa_id_hash TEXT,
        verification_token TEXT,
        expires_at TEXT NOT NULL,
        verification_expires_at TEXT,
        used_at TEXT,
        token_used_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE,
        FOREIGN KEY (customer_id) REFERENCES credit_customers (id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_credit_otp_merchant_phone
        ON credit_otp_codes(merchant_id, phone, purpose);
      CREATE INDEX IF NOT EXISTS idx_credit_otp_token
        ON credit_otp_codes(verification_token);
    `);
  }
}

function seedEscrowPoolZa(database: Database.Database) {
  const existing = database
    .prepare(
      `SELECT id FROM wallets WHERE wallet_kind = 'system_escrow' AND pool_id = ? LIMIT 1`
    )
    .get(DEFAULT_POOL_ID) as { id: string } | undefined;
  if (existing) return;

  const now = new Date().toISOString();
  const pool = DEFAULT_POOL_ID;
  const pinHash = hashPin('__KASIPAY_SYSTEM_ESCROW_NO_LOGIN__');
  const walletId = randomUUID();

  database.transaction(() => {
    const sysUser = database
      .prepare(`SELECT id FROM users WHERE id = ?`)
      .get(ESCROW_SYSTEM_USER_ID_ZA) as { id: string } | undefined;

    if (!sysUser) {
      database
        .prepare(
          `INSERT INTO users (
            id, name, phone, pin_hash, role, kyc_status, account_tier, created_at,
            country_code, is_system
          ) VALUES (?, ?, ?, ?, 'customer', 'verified', 'System', ?, ?, 1)`
        )
        .run(
          ESCROW_SYSTEM_USER_ID_ZA,
          'KasiPay network float (ZA)',
          ESCROW_SYSTEM_USER_PHONE_ZA,
          pinHash,
          now,
          pool
        );
    }

    database
      .prepare(
        `INSERT INTO wallets (
          id, user_id, balance, currency, status, pool_id, wallet_kind
        ) VALUES (?, ?, 0, ?, 'active', ?, 'system_escrow')`
      )
      .run(
        walletId,
        ESCROW_SYSTEM_USER_ID_ZA,
        currencyForPool(pool),
        pool
      );
  })();
}

/** Platform escrow ledger wallet for Cash Send / settlement (per pool). */
export function getEscrowWalletIdForPool(
  database: Database.Database,
  poolId: string
): string | undefined {
  const row = database
    .prepare(
      `SELECT id FROM wallets WHERE wallet_kind = 'system_escrow' AND pool_id = ? LIMIT 1`
    )
    .get(poolId) as { id: string } | undefined;
  return row?.id;
}

function seedDefaults(database: Database.Database) {
  const sc = database.prepare('SELECT COUNT(*) as c FROM suppliers').get() as {
    c: number;
  };
  if (sc.c === 0) {
    const ins = database.prepare(
      `INSERT INTO suppliers (id, name, phone, category, delivery_days_json)
       VALUES (?, ?, ?, ?, ?)`
    );
    ins.run(
      randomUUID(),
      'Wholesale National',
      '0860000000',
      'Dry goods',
      JSON.stringify(['Mon', 'Wed', 'Fri'])
    );
    ins.run(
      randomUUID(),
      'Fresh Produce Co.',
      '0115551234',
      'Produce',
      JSON.stringify(['Tue', 'Thu'])
    );
  }

  const lc = database
    .prepare('SELECT COUNT(*) as c FROM load_shedding_slots')
    .get() as { c: number };
  if (lc.c === 0) {
    const ins = database.prepare(
      `INSERT INTO load_shedding_slots (id, stage, start_time, end_time, area)
       VALUES (?, ?, ?, ?, ?)`
    );
    ins.run(randomUUID(), 2, '08:00', '10:00', 'Ekurhuleni Block 4');
    ins.run(randomUUID(), 4, '18:00', '20:30', 'Ekurhuleni Block 4');
    ins.run(randomUUID(), 1, '12:00', '14:00', 'Johannesburg City');
  }
}

export function getDb(): Database.Database {
  if (db) return db;
  const dir = path.dirname(DATABASE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const database = new Database(DATABASE_PATH);
  migrate(database);
  applyIncrementalMigrations(database);
  seedDefaults(database);
  seedEscrowPoolZa(database);
  db = database;
  return database;
}

export function closeDb() {
  db?.close();
  db = null;
}
