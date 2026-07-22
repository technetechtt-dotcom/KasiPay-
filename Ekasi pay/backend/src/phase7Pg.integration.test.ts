import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { Pool } from 'pg';

import {
  REQUIRED_READINESS_CONTROLS,
  canonicalEvidenceDigest,
  evaluateProductReadinessPg,
} from './productReadiness.js';

const connectionString = process.env.TEST_DATABASE_URL;

test('Phase 7 PostgreSQL controls', { skip: !connectionString }, async (suite) => {
  const pool = new Pool({ connectionString });
  suite.after(async () => pool.end());

  await suite.test('regulated product and control tables exist', async () => {
    const expected = [
      'product_readiness_evidence',
      'stokvel_accounts',
      'stokvel_contribution_records',
      'lending_product_versions',
      'regulated_loans',
      'merchant_credit_obligations',
      'merchant_credit_events',
      'insurance_product_versions',
      'regulated_insurance_claims',
      'utility_catalogue_versions',
      'utility_delivery_attempts',
    ];
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [expected],
    );
    assert.equal(tables.rowCount, expected.length);
  });

  await suite.test('all evidence is required and evidence cannot be rewritten', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const operatorId = `phase7-op-${randomUUID()}`;
      await client.query(
        `INSERT INTO ops_admin_users
           (id,username,password_hash,role,is_active,created_at,updated_at)
         VALUES ($1,$2,'not-a-real-password','finance',TRUE,clock_timestamp(),clock_timestamp())`,
        [operatorId, operatorId],
      );
      const ids: string[] = [];
      for (const control of REQUIRED_READINESS_CONTROLS) {
        const id = randomUUID();
        ids.push(id);
        const input = {
          product: 'lending' as const,
          environment: 'sandbox' as const,
          control,
          decision: 'approved' as const,
          authority: `Sandbox ${control} owner`,
          artifactUri: `test://phase7/${control}`,
          artifactSha256: createHash('sha256').update(control).digest('hex'),
          notes: 'Sandbox test evidence only; this is not external approval.',
        };
        await client.query(
          `INSERT INTO product_readiness_evidence
             (id,product,environment,control,decision,authority,authority_reference,
              artifact_uri,artifact_sha256,evidence_sha256,notes,recorded_by)
           VALUES ($1,'lending','sandbox',$2,'approved',$3,$4,$5,$6,$7,$8,$9)`,
          [
            id,
            control,
            input.authority,
            `TEST-${control}`,
            input.artifactUri,
            input.artifactSha256,
            canonicalEvidenceDigest(input),
            input.notes,
            operatorId,
          ],
        );
      }
      const readiness = await evaluateProductReadinessPg(client, 'lending', 'sandbox');
      assert.equal(readiness.databaseApproved, true);
      assert.equal(readiness.enabled, false, 'configuration remains a separate fail-closed gate');
      await assert.rejects(
        () => client.query(
          `UPDATE product_readiness_evidence SET notes = 'rewritten' WHERE id = $1`,
          [ids[0]],
        ),
        (error: unknown) => (error as { code?: string }).code === '55000',
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  await suite.test('historical financial records have immutable triggers', async () => {
    const triggers = await pool.query<{ table_name: string }>(
      `SELECT event_object_table table_name
         FROM information_schema.triggers
        WHERE trigger_schema = 'public'
          AND event_object_table = ANY($1::text[])
        GROUP BY event_object_table`,
      [[
        'stokvel_contribution_records',
        'loan_schedule_items',
        'loan_repayment_allocations',
        'merchant_credit_events',
        'insurance_policy_acceptances',
        'utility_delivery_attempts',
      ]],
    );
    assert.equal(triggers.rowCount, 6);
  });
});
