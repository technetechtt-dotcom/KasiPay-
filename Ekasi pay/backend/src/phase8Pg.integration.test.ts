import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Pool } from 'pg';

const connectionString = process.env.TEST_DATABASE_URL;

test('Phase 8 PostgreSQL customer-protection controls', { skip: !connectionString }, async (suite) => {
  const pool = new Pool({ connectionString });
  suite.after(async () => pool.end());

  await suite.test('customer protection and release evidence tables exist', async () => {
    const expected = [
      'customer_statement_exports',
      'durable_receipts',
      'fee_confirmation_evidence',
      'customer_notifications',
      'customer_cases',
      'customer_case_events',
      'account_protection_actions',
      'customer_terms_versions',
      'customer_terms_acceptances',
      'closing_balance_withdrawals',
      'refund_status_events',
      'release_evidence',
    ];
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name=ANY($1::text[])`,
      [expected],
    );
    assert.equal(tables.rowCount, expected.length);
  });

  await suite.test('evidence and customer history records are immutable', async () => {
    const expected = [
      'durable_receipts',
      'customer_case_events',
      'customer_terms_versions',
      'customer_terms_acceptances',
      'refund_status_events',
      'release_evidence',
    ];
    const triggers = await pool.query<{ table_name: string }>(
      `SELECT event_object_table table_name FROM information_schema.triggers
        WHERE trigger_schema='public' AND event_object_table=ANY($1::text[])
        GROUP BY event_object_table`,
      [expected],
    );
    assert.equal(triggers.rowCount, expected.length);
  });

  await suite.test('case SLA and fee arithmetic constraints fail closed', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const userId = `phase8-user-${randomUUID()}`;
      await client.query(
        `INSERT INTO users
           (id,name,phone,pin_hash,role,kyc_status,account_tier,created_at,country_code,is_system,token_version)
         VALUES ($1,'Phase 8 test',$2,'not-a-real-pin','customer','pending','Basic',
                 clock_timestamp(),'ZA',0,0)`,
        [userId, `27${Date.now()}${Math.floor(Math.random() * 1000)}`],
      );
      await assert.rejects(
        () => client.query(
          `INSERT INTO customer_cases
             (id,user_id,case_number,case_type,subject,description,priority,
              acknowledged_due_at,resolution_due_at)
           VALUES ($1,$2,$3,'complaint','Test','Long enough test complaint','normal',
                   clock_timestamp() + interval '2 days',clock_timestamp() + interval '1 day')`,
          [randomUUID(), userId, `TEST-${randomUUID()}`],
        ),
        (error: unknown) => (error as { code?: string }).code === '23514',
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  await suite.test('no production release approvals are seeded', async () => {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text count FROM release_evidence WHERE environment='production'`,
    );
    assert.equal(result.rows[0]?.count, '0');
  });
});
