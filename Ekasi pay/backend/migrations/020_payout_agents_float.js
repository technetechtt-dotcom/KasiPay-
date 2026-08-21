export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_user_id_key;
    DROP INDEX IF EXISTS wallets_user_id_key;

    ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_wallet_kind_check;
    ALTER TABLE wallets ADD CONSTRAINT wallets_wallet_kind_check
      CHECK (wallet_kind IN ('user', 'system_escrow', 'merchant_float'));

    CREATE UNIQUE INDEX IF NOT EXISTS wallets_user_kind_uidx
      ON wallets (user_id, wallet_kind);

    ALTER TABLE cash_send_vouchers
      ADD COLUMN IF NOT EXISTS payout_merchant_id TEXT REFERENCES users(id),
      ADD COLUMN IF NOT EXISTS payout_commission_cents BIGINT NOT NULL DEFAULT 0;

    CREATE TABLE IF NOT EXISTS payout_agents (
      merchant_id TEXT PRIMARY KEY REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'pending',
      float_floor_cents BIGINT NOT NULL DEFAULT 0,
      daily_payout_cap_cents BIGINT NOT NULL DEFAULT 200000,
      enrolled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT payout_agents_status_check
        CHECK (status IN ('pending', 'enrolled', 'suspended'))
    );
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS payout_agents;
    ALTER TABLE cash_send_vouchers
      DROP COLUMN IF EXISTS payout_merchant_id,
      DROP COLUMN IF EXISTS payout_commission_cents;
    DROP INDEX IF EXISTS wallets_user_kind_uidx;
    ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_wallet_kind_check;
    ALTER TABLE wallets ADD CONSTRAINT wallets_user_id_key UNIQUE (user_id);
  `);
};
