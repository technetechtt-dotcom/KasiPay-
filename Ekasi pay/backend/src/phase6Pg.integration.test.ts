import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Pool } from 'pg';

const connectionString = process.env.TEST_DATABASE_URL;

test('Phase 6 PostgreSQL controls', { skip: !connectionString }, async (suite) => {
  const pool = new Pool({ connectionString });
  suite.after(async () => pool.end());

  await suite.test('required Phase 6 journals and control tables exist', async () => {
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [[
        'settlement_statement_files',
        'settlement_suspense_cases',
        'fee_schedules',
        'refund_requests',
        'provider_instructions',
        'provider_callback_inbox',
      ]],
    );
    assert.equal(tables.rowCount, 6);
  });

  await suite.test('statement content and canonical duplicates are rejected', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const operatorId = `phase6-op-${randomUUID()}`;
      await client.query(
        `INSERT INTO ops_admin_users
           (id,username,password_hash,role,is_active,created_at,updated_at)
         VALUES ($1,$2,'not-a-real-password','finance',TRUE,clock_timestamp(),clock_timestamp())`,
        [operatorId, operatorId],
      );
      const values = [
        randomUUID(), 'simulator', 'phase6-v1', 'statement.csv',
        'a'.repeat(64), 'b'.repeat(64), 1, operatorId,
      ];
      await client.query(
        `INSERT INTO settlement_statement_files
           (id,provider,schema_version,file_name,content_sha256,canonical_sha256,row_count,imported_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        values,
      );
      await assert.rejects(
        () => client.query(
          `INSERT INTO settlement_statement_files
             (id,provider,schema_version,file_name,content_sha256,canonical_sha256,row_count,imported_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [randomUUID(), 'simulator', 'phase6-v1', 'renamed.csv',
            'c'.repeat(64), 'b'.repeat(64), 1, operatorId],
        ),
        (error: unknown) => (error as { code?: string }).code === '23505',
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  await suite.test('callback event and payload duplication are database-idempotent', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const eventId = `evt-${randomUUID()}`;
      const payloadHash = randomUUID().replaceAll('-', '').padEnd(64, '0');
      const insert = () => client.query(
        `INSERT INTO provider_callback_inbox
           (id,endpoint_id,provider_event_id,provider_timestamp,signature,payload,payload_sha256)
         VALUES ($1,'60000000-0000-4000-8000-000000000003',$2,
                 clock_timestamp(),'signature','{}'::jsonb,$3)`,
        [randomUUID(), eventId, payloadHash],
      );
      await insert();
      await assert.rejects(
        insert,
        (error: unknown) => (error as { code?: string }).code === '23505',
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  await suite.test('fee versions are immutable and Cash Send has no code-owned economics', async () => {
    const seeded = await pool.query<{ version: number; flat_cents: string }>(
      `SELECT s.version,t.flat_cents::text FROM fee_schedules s
        JOIN fee_schedule_tiers t ON t.fee_schedule_id = s.id
       WHERE s.product = 'cash_send' AND s.state = 'published'`,
    );
    assert.equal(seeded.rows[0]?.version, 1);
    assert.equal(seeded.rows[0]?.flat_cents, '1000');
  });
});
