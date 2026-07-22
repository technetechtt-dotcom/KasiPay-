/**
 * KYC document metadata for expiry and identity consistency checks.
 */
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE merchant_documents
      ADD COLUMN IF NOT EXISTS document_expires_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS subject_full_name TEXT,
      ADD COLUMN IF NOT EXISTS subject_id_hash TEXT;

    ALTER TABLE kyc_cases
      ADD COLUMN IF NOT EXISTS risk_score INTEGER CHECK (risk_score IS NULL OR risk_score BETWEEN 0 AND 1000),
      ADD COLUMN IF NOT EXISTS sanctions_screening_id UUID REFERENCES sanctions_screenings(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS review_checklist JSONB NOT NULL DEFAULT '{}'::jsonb;

    CREATE INDEX IF NOT EXISTS merchant_documents_subject_id_hash_idx
      ON merchant_documents(subject_id_hash)
      WHERE subject_id_hash IS NOT NULL AND deleted_at IS NULL;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS merchant_documents_subject_id_hash_idx;
    ALTER TABLE kyc_cases
      DROP COLUMN IF EXISTS risk_score,
      DROP COLUMN IF EXISTS sanctions_screening_id,
      DROP COLUMN IF EXISTS review_checklist;
    ALTER TABLE merchant_documents
      DROP COLUMN IF EXISTS document_expires_at,
      DROP COLUMN IF EXISTS subject_full_name,
      DROP COLUMN IF EXISTS subject_id_hash;
  `);
};
