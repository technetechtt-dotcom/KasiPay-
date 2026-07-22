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

// Never fall back to DATABASE_URL: that may point at a live environment.
const connectionString = process.env.TEST_DATABASE_URL;

async function fixture(pool: Pool, balanceCents = 10_000n) {
  const suffix = randomUUID();
  const fromUser = `ledger-user-from-${suffix}`;
  const toUser = `ledger-user-to-${suffix}`;
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
  return { fromWallet, toWallet };
}

test(
  'PostgreSQL ledger invariants and concurrency',
  { skip: !connectionString },
  async (suite) => {
    const pool = new Pool({ connectionString, max: 8 });
    suite.after(async () => pool.end());

    await suite.test('balanced posting is atomic and projection equals wallet', async () => {
      const wallets = await fixture(pool);
      const client = await pool.connect();
      let posting: { transactionId: string; reference: string };
      try {
        await client.query('BEGIN');
        posting = await postBetweenWalletsPg(client, {
          ...wallets,
          fromWalletId: wallets.fromWallet,
          toWalletId: wallets.toWallet,
          amountCents: parseIntegerCents('2500'),
          type: 'integration_transfer',
          referencePrefix: 'IT',
          description: 'integration posting',
        });
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      const sums = await pool.query<{ debit: string; credit: string }>(
        `SELECT sum(amount_cents) FILTER (WHERE side='debit')::text debit,
                sum(amount_cents) FILTER (WHERE side='credit')::text credit
           FROM journal_entries WHERE transaction_id = $1`,
        [posting!.transactionId],
      );
      assert.equal(sums.rows[0].debit, sums.rows[0].credit);
      const projection = await pool.query<{ mismatches: number }>(
        `SELECT count(*)::int mismatches
           FROM wallets w JOIN ledger_accounts a ON a.wallet_id = w.id
           JOIN account_balance_projections p ON p.account_id = a.id
          WHERE w.id = ANY($1::text[]) AND w.balance_cents <> p.available_cents`,
        [[wallets.fromWallet, wallets.toWallet]],
      );
      assert.equal(projection.rows[0].mismatches, 0);
    });

    await suite.test('concurrent withdrawals cannot make a negative balance', async () => {
      const wallets = await fixture(pool, 1_000n);
      const posting = () =>
        postBetweenWalletsWithRetryPg(pool, {
          fromWalletId: wallets.fromWallet,
          toWalletId: wallets.toWallet,
          amountCents: parseIntegerCents('800'),
          type: 'concurrent_withdrawal',
          referencePrefix: 'CW',
          description: 'concurrent withdrawal',
        });
      const results = await Promise.allSettled([posting(), posting()]);
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      const balance = await pool.query<{ balance_cents: string }>(
        `SELECT balance_cents FROM wallets WHERE id = $1`,
        [wallets.fromWallet],
      );
      assert.equal(balance.rows[0].balance_cents, '200');
    });

    await suite.test('partial/full refunds are linked and cannot over-refund', async () => {
      const wallets = await fixture(pool);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const original = await postBetweenWalletsPg(client, {
          fromWalletId: wallets.fromWallet,
          toWalletId: wallets.toWallet,
          amountCents: parseIntegerCents('3000'),
          type: 'sale',
          referencePrefix: 'SALE',
          description: 'sale',
        });
        await reverseWalletPostingPg(client, {
          originalTransactionId: original.transactionId,
          amountCents: parseIntegerCents('1000'),
          kind: 'refund',
          description: 'partial refund',
        });
        await reverseWalletPostingPg(client, {
          originalTransactionId: original.transactionId,
          amountCents: parseIntegerCents('2000'),
          kind: 'refund',
          description: 'final refund',
        });
        await assert.rejects(
          () =>
            reverseWalletPostingPg(client, {
              originalTransactionId: original.transactionId,
              amountCents: parseIntegerCents('1'),
              kind: 'refund',
              description: 'over refund',
            }),
          /exceeds unreversed amount/,
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    });

    await suite.test('unbalanced and immutable posted rows are rejected', async () => {
      const wallets = await fixture(pool);
      const posted = await postBetweenWalletsWithRetryPg(pool, {
        fromWalletId: wallets.fromWallet,
        toWalletId: wallets.toWallet,
        amountCents: parseIntegerCents('100'),
        type: 'immutable_test',
        referencePrefix: 'IMM',
        description: 'immutable',
      });
      await assert.rejects(
        () =>
          pool.query(`UPDATE journal_entries SET amount_cents = 101 WHERE transaction_id = $1`, [
            posted.transactionId,
          ]),
        /append-only/,
      );
      await assert.rejects(
        () => pool.query(`DELETE FROM journal_transactions WHERE id = $1`, [posted.transactionId]),
        /cannot be deleted/,
      );

      const account = await pool.query<{ id: string }>(
        `SELECT id FROM ledger_accounts WHERE wallet_id = $1`,
        [wallets.fromWallet],
      );
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const batchId = randomUUID();
        const transactionId = randomUUID();
        await client.query(
          `INSERT INTO posting_batches(id,source,state) VALUES ($1,'bad_test','authorized')`,
          [batchId],
        );
        await client.query(
          `INSERT INTO journal_transactions
             (id,batch_id,reference,transaction_type,description,currency,pool_id,state,effective_at)
           VALUES ($1,$2,$3,'bad_test','unbalanced','ZAR','ZA','authorized',clock_timestamp())`,
          [transactionId, batchId, `BAD-${transactionId.slice(0, 8)}`],
        );
        await client.query(
          `INSERT INTO journal_entries(id,transaction_id,account_id,side,amount_cents,currency)
           VALUES ($1,$2,$3,'debit',100,'ZAR')`,
          [randomUUID(), transactionId, account.rows[0].id],
        );
        await client.query(
          `UPDATE journal_transactions SET state='posted',posted_at=clock_timestamp() WHERE id=$1`,
          [transactionId],
        );
        await assert.rejects(() => client.query('COMMIT'), /unbalanced/);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });

    await suite.test('simultaneous duplicate claims and hash mismatch are deterministic', async () => {
      const actor = `actor-${randomUUID()}`;
      const key = randomUUID();
      const insert = (hash: string) =>
        pool.query(
          `INSERT INTO payment_idempotency
             (id,actor_id,route,client_key,request_hash,lifecycle,locked_until)
           VALUES ($1,$2,'POST /test',$3,$4,'in_flight',clock_timestamp()+interval '2 minutes')
           ON CONFLICT (actor_id,route,client_key) DO NOTHING RETURNING id`,
          [randomUUID(), actor, key, hash],
        );
      const [a, b] = await Promise.all([insert('a'.repeat(64)), insert('a'.repeat(64))]);
      assert.equal(a.rowCount! + b.rowCount!, 1);
      const mismatch = await insert('b'.repeat(64));
      assert.equal(mismatch.rowCount, 0);
      const stored = await pool.query<{ request_hash: string }>(
        `SELECT request_hash FROM payment_idempotency
          WHERE actor_id=$1 AND route='POST /test' AND client_key=$2`,
        [actor, key],
      );
      assert.equal(stored.rows[0].request_hash, 'a'.repeat(64));
      await pool.query(
        `UPDATE payment_idempotency
            SET lifecycle='completed',response_status=201,response_body='{"ok":true}'::jsonb
          WHERE actor_id=$1 AND route='POST /test' AND client_key=$2`,
        [actor, key],
      );
      const replay = await pool.query<{ response_status: number; response_body: { ok: boolean } }>(
        `SELECT response_status,response_body FROM payment_idempotency
          WHERE actor_id=$1 AND route='POST /test' AND client_key=$2`,
        [actor, key],
      );
      assert.deepEqual(replay.rows[0], { response_status: 201, response_body: { ok: true } });
    });

    await suite.test('voucher collect-vs-cancel and loan disbursement claims are single-winner', async () => {
      const wallets = await fixture(pool);
      const owner = await pool.query<{ user_id: string }>(
        `SELECT user_id FROM wallets WHERE id=$1`,
        [wallets.fromWallet],
      );
      const voucherId = randomUUID();
      await pool.query(
        `INSERT INTO cash_send_vouchers
          (id,sender_user_id,sender_phone,sender_first_name,sender_last_name,
           sender_id_document,sender_address,recipient_phone,recipient_first_name,
           recipient_last_name,recipient_id_document,amount_cents,fee_cents,pin_hash,
           reference_number,status,created_at,expires_at,collected_with_id_verified)
         VALUES ($1,$2,'1','A','B','1','x','2','C','D','2',100,0,'x',$3,
                 'active',clock_timestamp(),clock_timestamp()+interval '1 day',0)`,
        [voucherId, owner.rows[0].user_id, `CS${randomUUID().replaceAll('-', '').slice(0, 14)}`],
      );
      const voucherClaim = (state: string) =>
        pool.query(
          `UPDATE cash_send_vouchers SET status=$1 WHERE id=$2 AND status='active' RETURNING id`,
          [state, voucherId],
        );
      const voucherResults = await Promise.all([
        voucherClaim('collected'),
        voucherClaim('cancelled'),
      ]);
      assert.equal(voucherResults.reduce((sum, result) => sum + (result.rowCount ?? 0), 0), 1);

      const loanId = randomUUID();
      await pool.query(
        `INSERT INTO loans(id,user_id,amount_cents,interest_rate,status,repaid_amount_cents)
         VALUES ($1,$2,1000,0.1,'pending',0)`,
        [loanId, owner.rows[0].user_id],
      );
      const disburse = () =>
        pool.query(
          `UPDATE loans SET status='disbursing'
            WHERE id=$1 AND status='pending' RETURNING id`,
          [loanId],
        );
      const loanResults = await Promise.all([disburse(), disburse()]);
      assert.equal(loanResults.reduce((sum, result) => sum + (result.rowCount ?? 0), 0), 1);
    });
  },
);
