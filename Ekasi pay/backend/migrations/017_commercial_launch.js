export const up = (pgm) => {
  // Merchant Activation Records (R600 fee)
  pgm.createTable('merchant_activations', {
    id: { type: 'uuid', primaryKey: true },
    merchant_id: { type: 'text', notNull: true, references: 'users(id)' },
    status: { type: 'varchar(20)', notNull: true, default: "'pending'" }, // pending, paid, waived, complete
    fee_amount: { type: 'bigint', notNull: true, default: 60000 },
    payment_reference: { type: 'varchar(255)' },
    sponsor_programme: { type: 'varchar(255)' },
    agreement_accepted_at: { type: 'timestamptz' },
    activated_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  pgm.createIndex('merchant_activations', 'merchant_id');

  // Cash Send Settlement & Suspense
  pgm.createTable('cash_send_settlements', {
    id: { type: 'uuid', primaryKey: true },
    batch_id: { type: 'varchar(255)', notNull: true },
    status: { type: 'varchar(20)', notNull: true }, // pending, matched, exception
    amount: { type: 'bigint', notNull: true },
    provider_reference: { type: 'varchar(255)' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  // Expand cash_send_vouchers to track the R9 fee split (R6 platform, R3 merchant)
  pgm.addColumns('cash_send_vouchers', {
    platform_fee_cents: { type: 'bigint', notNull: true, default: 0 },
    merchant_commission_cents: { type: 'bigint', notNull: true, default: 0 },
    provider_fee_cents: { type: 'bigint', notNull: true, default: 0 },
    suspense_status: { type: 'varchar(20)' } // null, held, cleared
  });
};

export const down = (pgm) => {
  pgm.dropColumns('cash_send_vouchers', ['platform_fee_cents', 'merchant_commission_cents', 'provider_fee_cents', 'suspense_status']);
  pgm.dropTable('cash_send_settlements');
  pgm.dropTable('merchant_activations');
};
