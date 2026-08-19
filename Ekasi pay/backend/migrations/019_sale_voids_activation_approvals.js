export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE approval_requests DROP CONSTRAINT IF EXISTS approval_requests_action_type_check;
    ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_action_type_check
      CHECK (action_type IN (
        'loan_disbursement','loan_write_off','balance_adjustment',
        'merchant_approval_override','refund_reversal','user_role_change',
        'transaction_limit_change','settlement_resolution','daily_close',
        'fee_schedule_publish','insurance_claim_payout','posting_control_enable',
        'merchant_activation_waiver'
      ));

    ALTER TABLE sales ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS void_reason TEXT;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS discount_cents BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS receipt_number TEXT;

    CREATE UNIQUE INDEX IF NOT EXISTS sales_receipt_number_uidx
      ON sales(receipt_number) WHERE receipt_number IS NOT NULL;

    ALTER TABLE merchant_activations
      ADD COLUMN IF NOT EXISTS waived BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS discount_cents BIGINT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'unpaid',
      ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS accounting_treatment TEXT NOT NULL DEFAULT 'unrecognised',
      ADD COLUMN IF NOT EXISTS waiver_approval_id UUID;

    ALTER TABLE merchant_activations DROP CONSTRAINT IF EXISTS merchant_activations_status_check;
    ALTER TABLE merchant_activations ADD CONSTRAINT merchant_activations_status_check
      CHECK (status IN ('pending','paid','waived','complete'));
    ALTER TABLE merchant_activations DROP CONSTRAINT IF EXISTS merchant_activations_payment_status_check;
    ALTER TABLE merchant_activations ADD CONSTRAINT merchant_activations_payment_status_check
      CHECK (payment_status IN ('unpaid','pending','paid','waived','refunded'));
    ALTER TABLE merchant_activations DROP CONSTRAINT IF EXISTS merchant_activations_accounting_check;
    ALTER TABLE merchant_activations ADD CONSTRAINT merchant_activations_accounting_check
      CHECK (accounting_treatment IN (
        'unrecognised','deferred_revenue','activation_revenue','waived_sponsorship'
      ));

    CREATE UNIQUE INDEX IF NOT EXISTS merchant_activations_merchant_uidx
      ON merchant_activations(merchant_id);
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS merchant_activations_merchant_uidx;
    DROP INDEX IF EXISTS sales_receipt_number_uidx;
    ALTER TABLE sales DROP COLUMN IF EXISTS receipt_number;
    ALTER TABLE sales DROP COLUMN IF EXISTS discount_cents;
    ALTER TABLE sales DROP COLUMN IF EXISTS void_reason;
    ALTER TABLE sales DROP COLUMN IF EXISTS voided_at;
  `);
};
