/**
 * Drop Cash Send plaintext PII columns after encrypted copies are authoritative.
 * Run `npm run cash-send:backfill-pii` before this migration in environments
 * that may still hold legacy plaintext.
 *
 * The up() refuses to drop while any non-empty plaintext remains.
 */
export const up = (pgm) => {
  pgm.sql(`
    DO $$
    DECLARE
      leftover bigint;
    BEGIN
      SELECT count(*) INTO leftover
        FROM cash_send_vouchers
       WHERE COALESCE(sender_id_document, '') <> ''
          OR COALESCE(recipient_id_document, '') <> ''
          OR COALESCE(sender_address, '') <> ''
          OR COALESCE(collector_scanned_id, '') <> '';
      IF leftover > 0 THEN
        RAISE EXCEPTION
          'cash_send plaintext PII still present on % row(s); run scripts/backfill-cash-send-pii.mjs first',
          leftover;
      END IF;
    END $$;

    ALTER TABLE cash_send_vouchers
      DROP COLUMN IF EXISTS sender_id_document,
      DROP COLUMN IF EXISTS recipient_id_document,
      DROP COLUMN IF EXISTS sender_address,
      DROP COLUMN IF EXISTS collector_scanned_id;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE cash_send_vouchers
      ADD COLUMN IF NOT EXISTS sender_id_document TEXT,
      ADD COLUMN IF NOT EXISTS recipient_id_document TEXT,
      ADD COLUMN IF NOT EXISTS sender_address TEXT,
      ADD COLUMN IF NOT EXISTS collector_scanned_id TEXT;
  `);
};
