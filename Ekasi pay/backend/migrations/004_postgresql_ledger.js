/**
 * Phase 3: immutable double-entry journal and replay protection primitives.
 *
 * Existing `transactions`/`ledger_entries` remain as a compatibility projection.
 * They are deliberately not backfilled here: historical conversion requires an
 * operator-approved opening-balance report.
 */
export const up = (pgm) => {
  pgm.sql(String.raw`
    ALTER TABLE commission_postings
      ADD COLUMN reversal_of_id TEXT REFERENCES commission_postings(id) ON DELETE RESTRICT;
    CREATE UNIQUE INDEX commission_one_reversal_idx
      ON commission_postings(reversal_of_id) WHERE reversal_of_id IS NOT NULL;

    CREATE TABLE ledger_accounts (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      account_class TEXT NOT NULL CHECK (account_class IN
        ('asset','liability','equity','income','expense','memorandum')),
      normal_side TEXT NOT NULL CHECK (normal_side IN ('debit','credit')),
      currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
      pool_id TEXT NOT NULL,
      wallet_id TEXT UNIQUE REFERENCES wallets(id) ON DELETE RESTRICT,
      allow_negative BOOLEAN NOT NULL DEFAULT FALSE,
      system_managed BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );

    CREATE TABLE account_balance_projections (
      account_id TEXT PRIMARY KEY REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
      available_cents BIGINT NOT NULL DEFAULT 0,
      pending_cents BIGINT NOT NULL DEFAULT 0,
      version BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CHECK (pending_cents >= 0)
    );

    CREATE FUNCTION enforce_projection_nonnegative() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE may_overdraw boolean;
    BEGIN
      SELECT allow_negative INTO may_overdraw
        FROM ledger_accounts WHERE id = NEW.account_id;
      IF NOT COALESCE(may_overdraw, false) AND NEW.available_cents < 0 THEN
        RAISE EXCEPTION 'negative available projection for account %', NEW.account_id
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER account_projection_nonnegative
      BEFORE INSERT OR UPDATE ON account_balance_projections
      FOR EACH ROW EXECUTE FUNCTION enforce_projection_nonnegative();

    CREATE TABLE posting_batches (
      id UUID PRIMARY KEY,
      source TEXT NOT NULL,
      actor_id TEXT,
      state TEXT NOT NULL DEFAULT 'initiated'
        CHECK (state IN ('initiated','authorized','posted','settled','reversed','failed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      posted_at TIMESTAMPTZ,
      settled_at TIMESTAMPTZ
    );

    CREATE TABLE financial_references (
      reference TEXT PRIMARY KEY,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE (resource_type, resource_id)
    );
    INSERT INTO financial_references(reference, resource_type, resource_id, created_at)
      SELECT reference, 'legacy_transactions', id, created_at FROM transactions;
    INSERT INTO financial_references(reference, resource_type, resource_id, created_at)
      SELECT reference_number, 'cash_send_vouchers', id, created_at FROM cash_send_vouchers;
    INSERT INTO financial_references(reference, resource_type, resource_id, created_at)
      SELECT reference, 'utility_purchases', id, created_at FROM utility_purchases;

    CREATE TABLE journal_transactions (
      id UUID PRIMARY KEY,
      batch_id UUID NOT NULL REFERENCES posting_batches(id) ON DELETE RESTRICT,
      reference TEXT NOT NULL UNIQUE,
      transaction_type TEXT NOT NULL,
      description TEXT NOT NULL,
      currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
      pool_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN
        ('initiated','authorized','posted','settled','reversed','failed')),
      original_transaction_id UUID REFERENCES journal_transactions(id) ON DELETE RESTRICT,
      reversal_kind TEXT CHECK (reversal_kind IS NULL OR reversal_kind IN ('full','partial','refund')),
      effective_at TIMESTAMPTZ NOT NULL,
      settlement_due_at TIMESTAMPTZ,
      posted_at TIMESTAMPTZ,
      settled_at TIMESTAMPTZ,
      reversed_at TIMESTAMPTZ,
      failed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      CHECK ((original_transaction_id IS NULL) = (reversal_kind IS NULL)),
      CHECK (original_transaction_id IS NULL OR original_transaction_id <> id),
      CHECK (state NOT IN ('posted','settled','reversed') OR posted_at IS NOT NULL)
    );
    CREATE INDEX journal_transactions_original_idx
      ON journal_transactions(original_transaction_id);
    CREATE INDEX journal_transactions_effective_idx
      ON journal_transactions(effective_at, state);

    CREATE TABLE journal_entries (
      id UUID PRIMARY KEY,
      transaction_id UUID NOT NULL REFERENCES journal_transactions(id) ON DELETE RESTRICT,
      account_id TEXT NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
      side TEXT NOT NULL CHECK (side IN ('debit','credit')),
      amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
      currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE INDEX journal_entries_transaction_idx ON journal_entries(transaction_id);
    CREATE INDEX journal_entries_account_idx ON journal_entries(account_id, created_at);

    CREATE FUNCTION register_financial_reference() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO financial_references(reference, resource_type, resource_id)
      VALUES (NEW.reference, TG_TABLE_NAME, NEW.id::text);
      RETURN NEW;
    END $$;
    CREATE TRIGGER journal_reference_registry
      AFTER INSERT ON journal_transactions
      FOR EACH ROW EXECUTE FUNCTION register_financial_reference();

    CREATE FUNCTION register_cash_send_reference() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO financial_references(reference, resource_type, resource_id)
      VALUES (NEW.reference_number, TG_TABLE_NAME, NEW.id::text);
      RETURN NEW;
    END $$;
    CREATE TRIGGER cash_send_reference_registry
      AFTER INSERT ON cash_send_vouchers
      FOR EACH ROW EXECUTE FUNCTION register_cash_send_reference();
    CREATE TRIGGER utility_reference_registry
      AFTER INSERT ON utility_purchases
      FOR EACH ROW EXECUTE FUNCTION register_financial_reference();

    CREATE FUNCTION immutable_journal_entry() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'journal entries are append-only'
        USING ERRCODE = '55000';
    END $$;
    CREATE TRIGGER journal_entries_immutable
      BEFORE UPDATE OR DELETE ON journal_entries
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();

    CREATE FUNCTION protect_posted_journal_transaction() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' AND OLD.state IN ('posted','settled','reversed') THEN
        RAISE EXCEPTION 'posted financial records cannot be deleted'
          USING ERRCODE = '55000';
      END IF;
      IF TG_OP = 'UPDATE' AND OLD.state IN ('posted','settled','reversed') THEN
        IF NEW.id IS DISTINCT FROM OLD.id
          OR NEW.reference IS DISTINCT FROM OLD.reference
          OR NEW.transaction_type IS DISTINCT FROM OLD.transaction_type
          OR NEW.description IS DISTINCT FROM OLD.description
          OR NEW.currency IS DISTINCT FROM OLD.currency
          OR NEW.pool_id IS DISTINCT FROM OLD.pool_id
          OR NEW.original_transaction_id IS DISTINCT FROM OLD.original_transaction_id
          OR NEW.reversal_kind IS DISTINCT FROM OLD.reversal_kind
          OR NEW.effective_at IS DISTINCT FROM OLD.effective_at
          OR NEW.posted_at IS DISTINCT FROM OLD.posted_at
          OR NEW.metadata IS DISTINCT FROM OLD.metadata
          OR NOT (OLD.state = 'posted' AND NEW.state IN ('settled','reversed')
               OR OLD.state = 'settled' AND NEW.state = 'reversed'
               OR NEW.state = OLD.state) THEN
          RAISE EXCEPTION 'posted journal transaction is immutable; use a reversal'
            USING ERRCODE = '55000';
        END IF;
      END IF;
      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER journal_transactions_protected
      BEFORE UPDATE OR DELETE ON journal_transactions
      FOR EACH ROW EXECUTE FUNCTION protect_posted_journal_transaction();

    CREATE TRIGGER commission_postings_immutable
      BEFORE UPDATE OR DELETE ON commission_postings
      FOR EACH ROW EXECUTE FUNCTION immutable_journal_entry();

    CREATE FUNCTION validate_posted_transaction_balanced() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE transaction_uuid uuid;
    DECLARE transaction_state text;
    DECLARE debit_total numeric;
    DECLARE credit_total numeric;
    DECLARE invalid_entries bigint;
    DECLARE payload jsonb;
    BEGIN
      -- Shared across journal_transactions and journal_entries: never touch
      -- NEW.column directly for table-specific fields (PL/pgSQL plans them).
      payload := to_jsonb(COALESCE(NEW, OLD));
      IF TG_TABLE_NAME = 'journal_transactions' THEN
        transaction_uuid := (payload->>'id')::uuid;
      ELSE
        transaction_uuid := (payload->>'transaction_id')::uuid;
      END IF;
      SELECT state INTO transaction_state FROM journal_transactions
        WHERE id = transaction_uuid;
      IF transaction_state IN ('posted','settled','reversed') THEN
        SELECT
          COALESCE(sum(amount_cents) FILTER (WHERE side = 'debit'), 0),
          COALESCE(sum(amount_cents) FILTER (WHERE side = 'credit'), 0),
          count(*) FILTER (WHERE e.currency <> t.currency OR a.currency <> t.currency
                            OR a.pool_id <> t.pool_id)
        INTO debit_total, credit_total, invalid_entries
        FROM journal_entries e
        JOIN journal_transactions t ON t.id = e.transaction_id
        JOIN ledger_accounts a ON a.id = e.account_id
        WHERE e.transaction_id = transaction_uuid
        GROUP BY t.id;
        IF debit_total IS NULL OR debit_total = 0 OR debit_total <> credit_total THEN
          RAISE EXCEPTION 'posted transaction % is unbalanced (% debit, % credit)',
            transaction_uuid, COALESCE(debit_total, 0), COALESCE(credit_total, 0)
            USING ERRCODE = '23514';
        END IF;
        IF invalid_entries <> 0 THEN
          RAISE EXCEPTION 'posted transaction % has currency/pool mismatch', transaction_uuid
            USING ERRCODE = '23514';
        END IF;
      END IF;
      RETURN NULL;
    END $$;
    CREATE CONSTRAINT TRIGGER journal_entries_balanced
      AFTER INSERT OR UPDATE OR DELETE ON journal_entries
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION validate_posted_transaction_balanced();
    CREATE CONSTRAINT TRIGGER journal_transaction_balanced
      AFTER INSERT OR UPDATE ON journal_transactions
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION validate_posted_transaction_balanced();

    CREATE TABLE payment_idempotency (
      id UUID PRIMARY KEY,
      actor_id TEXT NOT NULL,
      route TEXT NOT NULL,
      client_key TEXT NOT NULL,
      request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('in_flight','completed','failed')),
      posting_id UUID REFERENCES journal_transactions(id) ON DELETE RESTRICT,
      financial_reference TEXT,
      response_status INTEGER,
      response_body JSONB,
      locked_until TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      completed_at TIMESTAMPTZ,
      UNIQUE (actor_id, route, client_key),
      CHECK ((lifecycle = 'completed') = (response_status IS NOT NULL AND response_body IS NOT NULL))
    );

    CREATE TABLE webhook_inbox (
      id UUID PRIMARY KEY,
      provider TEXT NOT NULL,
      event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
      signature TEXT NOT NULL,
      payload JSONB NOT NULL,
      state TEXT NOT NULL DEFAULT 'received'
        CHECK (state IN ('received','processing','processed','failed')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      locked_until TIMESTAMPTZ,
      processed_at TIMESTAMPTZ,
      last_error TEXT,
      UNIQUE (provider, event_id)
    );

    CREATE TABLE voucher_replay_guard (
      voucher_id TEXT NOT NULL REFERENCES cash_send_vouchers(id) ON DELETE RESTRICT,
      operation TEXT NOT NULL CHECK (operation IN ('collect','cancel','expire')),
      request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
      journal_transaction_id UUID REFERENCES journal_transactions(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (voucher_id, operation)
    );

    CREATE TABLE ledger_backfill_status (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      state TEXT NOT NULL CHECK (state IN ('not_required','pending_signoff','completed')),
      legacy_transactions BIGINT NOT NULL,
      checked_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      completed_at TIMESTAMPTZ,
      report JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    INSERT INTO ledger_backfill_status(id, state, legacy_transactions)
    SELECT 1,
      CASE WHEN count(*) = 0
             AND NOT EXISTS (SELECT 1 FROM wallets WHERE balance_cents <> 0)
           THEN 'not_required' ELSE 'pending_signoff' END,
      count(*)
    FROM transactions;

    INSERT INTO ledger_accounts
      (id, code, name, account_class, normal_side, currency, pool_id, allow_negative)
    VALUES
      ('system:safeguarded-cash:zar','1000-ZAR','Safeguarded cash','asset','debit','ZAR','ZA',true),
      ('system:customer-liability:zar','2000-ZAR','Customer wallet liabilities','liability','credit','ZAR','ZA',true),
      ('system:merchant-settlement:zar','2100-ZAR','Merchant settlement payable','liability','credit','ZAR','ZA',true),
      ('system:suspense:zar','2990-ZAR','Settlement suspense','liability','credit','ZAR','ZA',true),
      ('system:fees:zar','4000-ZAR','Fee income','income','credit','ZAR','ZA',true),
      ('system:tax:zar','2200-ZAR','Tax payable','liability','credit','ZAR','ZA',true),
      ('system:commissions:zar','5000-ZAR','Commission expense','expense','debit','ZAR','ZA',true),
      ('system:provider-settlement:zar','2300-ZAR','Provider settlement','liability','credit','ZAR','ZA',true),
      ('system:loan-principal:zar','1100-ZAR','Loan principal receivable','asset','debit','ZAR','ZA',true),
      ('system:loan-interest:zar','4100-ZAR','Loan interest income','income','credit','ZAR','ZA',true),
      ('system:loan-impairment:zar','5100-ZAR','Loan impairment','expense','debit','ZAR','ZA',true),
      ('system:refunds:zar','5200-ZAR','Refunds and reversals','expense','debit','ZAR','ZA',true),
      ('system:product-escrow:zar','2400-ZAR','Product escrow liability','liability','credit','ZAR','ZA',true);
    INSERT INTO account_balance_projections(account_id)
      SELECT id FROM ledger_accounts;
  `);
};

export const down = false;
