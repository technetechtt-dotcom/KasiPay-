/**
 * Encrypt Cash Send personal identifiers at rest.
 * Adds blind-index hash columns; application writes encrypted copies and
 * clears plaintext ID/address columns.
 */
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE cash_send_vouchers
      ADD COLUMN IF NOT EXISTS sender_id_hash TEXT,
      ADD COLUMN IF NOT EXISTS recipient_id_hash TEXT,
      ADD COLUMN IF NOT EXISTS collector_scanned_id_hash TEXT,
      ADD COLUMN IF NOT EXISTS sender_id_document_encrypted TEXT,
      ADD COLUMN IF NOT EXISTS recipient_id_document_encrypted TEXT,
      ADD COLUMN IF NOT EXISTS sender_address_encrypted TEXT,
      ADD COLUMN IF NOT EXISTS collector_scanned_id_encrypted TEXT;

    CREATE INDEX IF NOT EXISTS idx_cash_send_sender_id_hash
      ON cash_send_vouchers(sender_id_hash)
      WHERE sender_id_hash IS NOT NULL AND sender_id_hash <> '';

    CREATE INDEX IF NOT EXISTS idx_cash_send_recipient_id_hash
      ON cash_send_vouchers(recipient_id_hash)
      WHERE recipient_id_hash IS NOT NULL AND recipient_id_hash <> '';
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_cash_send_recipient_id_hash;
    DROP INDEX IF EXISTS idx_cash_send_sender_id_hash;
    ALTER TABLE cash_send_vouchers
      DROP COLUMN IF EXISTS collector_scanned_id_encrypted,
      DROP COLUMN IF EXISTS sender_address_encrypted,
      DROP COLUMN IF EXISTS recipient_id_document_encrypted,
      DROP COLUMN IF EXISTS sender_id_document_encrypted,
      DROP COLUMN IF EXISTS collector_scanned_id_hash,
      DROP COLUMN IF EXISTS recipient_id_hash,
      DROP COLUMN IF EXISTS sender_id_hash;
  `);
};
