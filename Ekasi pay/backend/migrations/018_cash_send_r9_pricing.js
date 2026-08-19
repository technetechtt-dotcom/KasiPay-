export const up = (pgm) => {
  // We need to end the previous R10 fee schedule and insert the new R9 fee schedule
  // R9 total fee (900 cents) -> R6 platform (600 cents), R3 merchant (300 cents)
  // We use merchant: 3334, platform: 6666 because Postgres jsonb sorts keys alphabetically 
  // (merchant comes first). 900 * 3334 / 10000 = 300 (R3.00). Remainder is 600 (R6.00).
  
  // 1. Update the state of the old schedule to 'superseded'
  pgm.sql(`
    UPDATE fee_schedules
    SET state = 'retired',
        effective_to = NOW()
    WHERE code = 'CASH_SEND_STANDARD' AND version = 1 AND state = 'published';
  `);

  // 2. Insert the new R9 schedule
  pgm.sql(`
    INSERT INTO fee_schedules
      (id,code,version,currency,product,effective_from,state)
    VALUES
      ('60000000-0000-4000-8000-000000000003','CASH_SEND_STANDARD',2,'ZAR',
       'cash_send', NOW(), 'published');
  `);

  // 3. Insert the new R9 tier
  pgm.sql(`
    INSERT INTO fee_schedule_tiers
      (id,fee_schedule_id,min_cents,max_cents,flat_cents,rate_basis_points,
       min_fee_cents,max_fee_cents,allocations)
    VALUES
      ('60000000-0000-4000-8000-000000000004',
       '60000000-0000-4000-8000-000000000003',0,NULL,900,0,900,900,
       '{"merchant":3334,"platform":6666}'::jsonb);
  `);
};

export const down = (pgm) => {
  pgm.sql(`DELETE FROM fee_schedule_tiers WHERE id = '60000000-0000-4000-8000-000000000004';`);
  pgm.sql(`DELETE FROM fee_schedules WHERE id = '60000000-0000-4000-8000-000000000003';`);
  pgm.sql(`
    UPDATE fee_schedules 
    SET state = 'published' 
    WHERE code = 'CASH_SEND_STANDARD' AND version = 1;
  `);
};
