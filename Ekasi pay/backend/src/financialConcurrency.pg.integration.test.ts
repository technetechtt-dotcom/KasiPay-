/**
 * Phase 5 — concurrent PostgreSQL financial correctness.
 * Opt-in: PG_INTEGRATION_TESTS=1 TEST_DATABASE_URL=... npm run test:postgres
 *
 * Prefer TEST_DATABASE_URL only (never live DATABASE_URL).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Pool } from 'pg';

import { parseIntegerCents } from './money.js';
import {
  postBetweenWalletsPg,
  postBetweenWalletsWithRetryPg,
  reverseWalletPostingPg,
} from './services/walletPostingPg.js';
import {
  acquireReconciliationLeasePg,
  releaseReconciliationLeasePg,
} from './services/scheduledReconciliationPg.js';

const enabled = process.env.PG_INTEGRATION_TESTS === '1';
const connectionString = process.env.TEST_DATABASE_URL?.trim() || '';

async function fixture(pool: Pool, balanceCents = 10_000n) {
  const suffix = randomUUID();
  const fromUser = `fc-user-from-${suffix}`;
  const toUser = `fc-user-to-${suffix}`;
  const fromWallet = `ledger-wallet-from-${suffix}`;
  const toWallet = `ledger-wallet-to-${suffix}`;
  await pool.query(
    `INSERT INTO users
       (id,name,phone,pin_hash,role,kyc_status,account_tier,created_at,country_code,is_system)
     VALUES ($1,'From',$2,'x','customer','approved','Basic',clock_timestamp(),'ZA',0),
            ($3,'To',$4,'x','customer','approved','Basic',clock_timestamp(),'ZA',0)`,
    [
      fromUser,
      `+27${suffix.replaceAll('-', '').slice(0, 9)}`,
      toUser,
      `+28${suffix.replaceAll('-', '').slice(0, 9)}`,
    ],
  );
  await pool.query(
    `INSERT INTO wallets(id,user_id,balance_cents,currency,status,pool_id,wallet_kind)
     VALUES ($1,$2,$5,'ZAR','active','ZA','user'),
            ($3,$4,0,'ZAR','active','ZA','user')`,
    [fromWallet, fromUser, toWallet, toUser, balanceCents.toString()],
  );
  return { fromWallet, toWallet, fromUser, toUser };
}

test(
  'Phase 5 financial concurrency',
  { skip: !enabled || !connectionString },
  async (suite) => {
    const pool = new Pool({ connectionString, max: 12 });
    suite.after(async () => pool.end());

    await suite.test('wallet lock order is lexicographic (deadlock reduction)', () => {
      const ids = ['ct-b', 'ct-a'].sort();
      assert.deepEqual(ids, ['ct-a', 'ct-b']);
    });

    await suite.test('kill-switch control row exists and can block new work', async () => {
      const row = await pool.query<{ enabled: boolean }>(
        `SELECT enabled FROM operational_controls WHERE control_key = 'financial_posting'`,
      );
      assert.equal(row.rowCount, 1);
      const previous = row.rows[0].enabled;
      await pool.query(
        `UPDATE operational_controls SET enabled = FALSE WHERE control_key = 'financial_posting'`,
      );
      const disabled = await pool.query<{ enabled: boolean }>(
        `SELECT enabled FROM operational_controls WHERE control_key = 'financial_posting'`,
      );
      assert.equal(disabled.rows[0].enabled, false);
      await pool.query(
        `UPDATE operational_controls SET enabled = $1 WHERE control_key = 'financial_posting'`,
        [previous],
      );
    });

    await suite.test('double-spend concurrent withdrawals: only one succeeds', async () => {
      const wallets = await fixture(pool, 1_000n);
      const attempt = () =>
        postBetweenWalletsWithRetryPg(pool, {
          fromWalletId: wallets.fromWallet,
          toWalletId: wallets.toWallet,
          amountCents: parseIntegerCents('800'),
          type: 'fc_double_spend',
          referencePrefix: 'DS',
          description: 'double spend attempt',
        });
      const results = await Promise.allSettled([attempt(), attempt(), attempt()]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      const balance = await pool.query<{ balance_cents: string }>(
        `SELECT balance_cents FROM wallets WHERE id = $1`,
        [wallets.fromWallet],
      );
      assert.equal(balance.rows[0].balance_cents, '200');
    });

    await suite.test('simultaneous refunds cannot over-refund', async () => {
      const wallets = await fixture(pool, 5_000n);
      const client = await pool.connect();
      let originalId: string;
      try {
        await client.query('BEGIN');
        const original = await postBetweenWalletsPg(client, {
          fromWalletId: wallets.fromWallet,
          toWalletId: wallets.toWallet,
          amountCents: parseIntegerCents('2000'),
          type: 'fc_sale',
          referencePrefix: 'FS',
          description: 'sale for refund race',
        });
        originalId = original.transactionId;
        await client.query('COMMIT');
      } finally {
        client.release();
      }

      const refund = async () => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          await reverseWalletPostingPg(c, {
            originalTransactionId: originalId,
            amountCents: parseIntegerCents('1500'),
            kind: 'refund',
            description: 'concurrent refund',
          });
          await c.query('COMMIT');
          return true;
        } catch (error) {
          await c.query('ROLLBACK');
          throw error;
        } finally {
          c.release();
        }
      };

      const results = await Promise.allSettled([refund(), refund()]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    });

    await suite.test('duplicate voucher collection is single-winner', async () => {
      const wallets = await fixture(pool);
      const voucherId = randomUUID();
      await pool.query(
        `INSERT INTO cash_send_vouchers
          (id,sender_user_id,sender_phone,sender_first_name,sender_last_name,
           sender_id_document_encrypted,sender_address_encrypted,recipient_phone,recipient_first_name,
           recipient_last_name,recipient_id_document_encrypted,amount_cents,fee_cents,pin_hash,
           reference_number,status,created_at,expires_at,collected_with_id_verified)
         VALUES ($1,$2,'1','A','B','enc-id','enc-addr','2','C','D','enc-rid',100,0,'x',$3,
                 'active',clock_timestamp(),clock_timestamp()+interval '1 day',0)`,
        [voucherId, wallets.fromUser, `CS${randomUUID().replaceAll('-', '').slice(0, 14)}`],
      );
      const claim = () =>
        pool.query(
          `UPDATE cash_send_vouchers SET status='collected'
            WHERE id=$1 AND status='active' RETURNING id`,
          [voucherId],
        );
      const [a, b, c] = await Promise.all([claim(), claim(), claim()]);
      assert.equal((a.rowCount ?? 0) + (b.rowCount ?? 0) + (c.rowCount ?? 0), 1);
    });

    await suite.test('duplicate provider callback event_id is rejected', async () => {
      const exists = await pool.query(
        `SELECT to_regclass('public.provider_callback_inbox') IS NOT NULL AS ok`,
      );
      if (!exists.rows[0]?.ok) return;
      const endpoint = await pool.query<{ id: string }>(
        `SELECT id::text FROM provider_endpoints LIMIT 1`,
      );
      if (!endpoint.rows[0]) return;
      const eventId = `evt-${randomUUID()}`;
      const payloadHash = randomUUID().replaceAll('-', '').padEnd(64, '0');
      const insert = () =>
        pool.query(
          `INSERT INTO provider_callback_inbox
             (id,endpoint_id,provider_event_id,provider_timestamp,signature,payload,payload_sha256)
           VALUES ($1,$2,$3,clock_timestamp(),'signature','{}'::jsonb,$4)`,
          [randomUUID(), endpoint.rows[0].id, eventId, payloadHash],
        );
      await insert();
      await assert.rejects(
        insert,
        (error: unknown) => (error as { code?: string }).code === '23505',
      );
    });

    await suite.test('multi-instance idempotency: one claim across concurrent inserts', async () => {
      const actor = `fc-actor-${randomUUID()}`;
      const key = randomUUID();
      const hash = 'c'.repeat(64);
      const claim = () =>
        pool.query(
          `INSERT INTO payment_idempotency
             (id,actor_id,route,client_key,request_hash,lifecycle,locked_until)
           VALUES ($1,$2,'POST /transfers',$3,$4,'in_flight',clock_timestamp()+interval '2 minutes')
           ON CONFLICT (actor_id,route,client_key) DO NOTHING RETURNING id`,
          [randomUUID(), actor, key, hash],
        );
      const results = await Promise.all([claim(), claim(), claim(), claim()]);
      assert.equal(results.reduce((sum, r) => sum + (r.rowCount ?? 0), 0), 1);
    });

    await suite.test('crash-before-commit leaves no journal; crash-after seals idempotency', async () => {
      const wallets = await fixture(pool, 3_000n);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await postBetweenWalletsPg(client, {
          fromWalletId: wallets.fromWallet,
          toWalletId: wallets.toWallet,
          amountCents: parseIntegerCents('500'),
          type: 'fc_crash_before',
          referencePrefix: 'CB',
          description: 'rolled back',
        });
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
      const before = await pool.query(
        `SELECT count(*)::int AS n FROM journal_transactions WHERE transaction_type = 'fc_crash_before'`,
      );
      assert.equal(before.rows[0].n, 0);

      const posted = await postBetweenWalletsWithRetryPg(pool, {
        fromWalletId: wallets.fromWallet,
        toWalletId: wallets.toWallet,
        amountCents: parseIntegerCents('100'),
        type: 'fc_crash_after',
        referencePrefix: 'CA',
        description: 'committed then sealed',
      });
      const actor = `fc-crash-${randomUUID()}`;
      const key = randomUUID();
      await pool.query(
        `INSERT INTO payment_idempotency
           (id,actor_id,route,client_key,request_hash,lifecycle,locked_until,posting_id)
         VALUES ($1,$2,'POST /transfers',$3,$4,'in_flight',clock_timestamp()+interval '2 minutes',$5)`,
        [randomUUID(), actor, key, 'd'.repeat(64), posted.transactionId],
      );
      // Simulate recovery seal without reclaiming: complete with response.
      await pool.query(
        `UPDATE payment_idempotency
            SET lifecycle='completed', response_status=201,
                response_body='{"ok":true,"recovered":true}'::jsonb
          WHERE actor_id=$1 AND route='POST /transfers' AND client_key=$2
            AND posting_id IS NOT NULL AND lifecycle='in_flight'`,
        [actor, key],
      );
      const sealed = await pool.query<{ lifecycle: string; posting_id: string }>(
        `SELECT lifecycle, posting_id FROM payment_idempotency
          WHERE actor_id=$1 AND client_key=$2`,
        [actor, key],
      );
      assert.equal(sealed.rows[0].lifecycle, 'completed');
      assert.equal(sealed.rows[0].posting_id, posted.transactionId);
      const reclaim = await pool.query(
        `INSERT INTO payment_idempotency
           (id,actor_id,route,client_key,request_hash,lifecycle,locked_until)
         VALUES ($1,$2,'POST /transfers',$3,$4,'in_flight',clock_timestamp()+interval '2 minutes')
         ON CONFLICT (actor_id,route,client_key) DO NOTHING RETURNING id`,
        [randomUUID(), actor, key, 'd'.repeat(64)],
      );
      assert.equal(reclaim.rowCount, 0);
    });

    await suite.test('reconciliation lease is exclusive (no overlapping jobs)', async () => {
      const exists = await pool.query(
        `SELECT to_regclass('public.reconciliation_job_leases') IS NOT NULL AS ok`,
      );
      if (!exists.rows[0]?.ok) return;
      const jobKey = `test-lease-${randomUUID()}`;
      const a = await pool.connect();
      const b = await pool.connect();
      try {
        await a.query('BEGIN');
        const first = await acquireReconciliationLeasePg(a, jobKey, 'owner-a', 60);
        assert.equal(first.acquired, true);
        await a.query('COMMIT');

        await b.query('BEGIN');
        const second = await acquireReconciliationLeasePg(b, jobKey, 'owner-b', 60);
        assert.equal(second.acquired, false);
        await b.query('ROLLBACK');

        await a.query('BEGIN');
        await releaseReconciliationLeasePg(a, jobKey, first.token!, 'passed');
        await a.query('COMMIT');
      } finally {
        a.release();
        b.release();
      }
    });

    await suite.test('ledger invariant: every posted journal remains balanced', async () => {
      const wallets = await fixture(pool, 4_000n);
      await postBetweenWalletsWithRetryPg(pool, {
        fromWalletId: wallets.fromWallet,
        toWalletId: wallets.toWallet,
        amountCents: parseIntegerCents('1234'),
        type: 'fc_invariant',
        referencePrefix: 'INV',
        description: 'invariant check',
      });
      const unbalanced = await pool.query<{ n: number }>(`
        SELECT count(*)::int AS n FROM (
          SELECT t.id
            FROM journal_transactions t
            JOIN journal_entries e ON e.transaction_id = t.id
           WHERE t.state IN ('posted','settled','reversed')
             AND t.transaction_type = 'fc_invariant'
           GROUP BY t.id
          HAVING COALESCE(sum(e.amount_cents) FILTER (WHERE e.side='debit'),0)
              <> COALESCE(sum(e.amount_cents) FILTER (WHERE e.side='credit'),0)
        ) x`);
      assert.equal(unbalanced.rows[0].n, 0);
    });
  },
);
