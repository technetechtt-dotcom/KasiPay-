/**
 * Credit-only client-funds matching, unique bank backing, cash liquidity
 * reservations, payout OTPs, and worker heartbeats.
 */
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE bank_accounts
      ADD COLUMN IF NOT EXISTS approved BOOLEAN NOT NULL DEFAULT FALSE;

    ALTER TABLE merchant_float_topups
      ADD COLUMN IF NOT EXISTS bank_recognition_journal_id UUID;

    CREATE UNIQUE INDEX IF NOT EXISTS merchant_float_topups_bank_tx_uidx
      ON merchant_float_topups (bank_transaction_id)
      WHERE bank_transaction_id IS NOT NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS bank_transactions_matched_topup_uidx
      ON bank_transactions (matched_topup_id)
      WHERE matched_topup_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS merchant_cash_liquidity (
      merchant_id TEXT PRIMARY KEY REFERENCES merchants(id) ON DELETE RESTRICT,
      available_cents BIGINT NOT NULL DEFAULT 0 CHECK (available_cents >= 0),
      reserved_cents BIGINT NOT NULL DEFAULT 0 CHECK (reserved_cents >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CHECK (reserved_cents <= available_cents)
    );

    CREATE TABLE IF NOT EXISTS merchant_cash_reservations (
      id UUID PRIMARY KEY,
      merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
      voucher_id TEXT NOT NULL UNIQUE,
      amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
      state TEXT NOT NULL CHECK (state IN ('reserved','consumed','released')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE INDEX IF NOT EXISTS merchant_cash_reservations_merchant_idx
      ON merchant_cash_reservations (merchant_id, state);

    CREATE TABLE IF NOT EXISTS cash_send_payout_otps (
      id UUID PRIMARY KEY,
      voucher_id TEXT NOT NULL,
      phone_hash TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE INDEX IF NOT EXISTS cash_send_payout_otps_voucher_idx
      ON cash_send_payout_otps (voucher_id, consumed_at);

    CREATE TABLE IF NOT EXISTS reconciliation_worker_heartbeats (
      worker_id TEXT PRIMARY KEY,
      schema_fingerprint TEXT,
      schema_migrations INTEGER,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS reconciliation_worker_heartbeats;
    DROP TABLE IF EXISTS cash_send_payout_otps;
    DROP TABLE IF EXISTS merchant_cash_reservations;
    DROP TABLE IF EXISTS merchant_cash_liquidity;
    DROP INDEX IF EXISTS bank_transactions_matched_topup_uidx;
    DROP INDEX IF EXISTS merchant_float_topups_bank_tx_uidx;
    ALTER TABLE merchant_float_topups
      DROP COLUMN IF EXISTS bank_recognition_journal_id;
    ALTER TABLE bank_accounts
      DROP COLUMN IF EXISTS approved;
  `);
};
