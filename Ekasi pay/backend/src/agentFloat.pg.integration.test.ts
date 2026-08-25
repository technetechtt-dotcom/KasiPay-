import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Pool } from 'pg';

import { ingestBankDepositPg } from './services/bankDepositMatchingPg.js';
import { createFeeReversalAmounts } from './services/cashSendFeeSplit.js';
import { reverseCashSendCreateFeesPg } from './services/feeLifecyclePg.js';
import { requestFloatTopupPg } from './services/merchantFloatPg.js';
import { postBetweenWalletsPg } from './services/walletPostingPg.js';
import { assertWalletKindPair } from './services/walletKindsPg.js';

const CLIENT_FUNDS_FINGERPRINT = 'TEST-CLIENT-FUNDS-ZA-ZAR';

async function seedApprovedClientFunds(pool: Pool) {
  const accountId = randomUUID();
  await pool.query(
    `INSERT INTO bank_accounts
       (id, label, purpose, currency, pool_id, account_fingerprint, approved)
     VALUES ($1,'Test client funds','client_funds','ZAR','ZA',$2,TRUE)
     ON CONFLICT (purpose, currency, pool_id)
     DO UPDATE SET approved = TRUE, account_fingerprint = EXCLUDED.account_fingerprint`,
    [accountId, CLIENT_FUNDS_FINGERPRINT],
  );
  const account = await pool.query<{ id: string }>(
    `SELECT id FROM bank_accounts
      WHERE purpose = 'client_funds' AND currency = 'ZAR' AND pool_id = 'ZA'`,
  );
  await pool.query(
    `INSERT INTO safeguarding_accounts (id, bank_account_id, pool_id, currency)
     VALUES ($1,$2,'ZA','ZAR')
     ON CONFLICT (pool_id, currency) DO NOTHING`,
    [randomUUID(), account.rows[0].id],
  );
}

const connectionString = process.env.TEST_DATABASE_URL;

test(
  'agent float postgres: cash-in escrow cash-out and consecutive top-ups',
  { skip: !connectionString },
  async (suite) => {
    const pool = new Pool({ connectionString, max: 4 });
    suite.after(async () => pool.end());

    await suite.test('consecutive float top-up references stay unique', async () => {
      const suffix = randomUUID();
      const userId = `float-user-${suffix}`;
      const merchantPk = `float-merch-${suffix}`;
      await pool.query(
        `INSERT INTO users
           (id,name,phone,pin_hash,role,kyc_status,account_tier,created_at,country_code,is_system)
         VALUES ($1,'Float',$2,'x','merchant','verified','Basic',clock_timestamp(),'ZA',0)`,
        [userId, `+27${suffix.replaceAll('-', '').slice(0, 9)}`],
      );
      await pool.query(
        `INSERT INTO merchants (id, user_id, business_name, location, category, approval_status)
         VALUES ($1,$2,'Float Shop','ZA','spaza','approved')`,
        [merchantPk, userId],
      );
      const first = await requestFloatTopupPg(pool, {
        merchantUserId: userId,
        merchantId: merchantPk,
        amountCents: 10_000n,
        requestId: randomUUID(),
        correlationId: randomUUID(),
      });
      const second = await requestFloatTopupPg(pool, {
        merchantUserId: userId,
        merchantId: merchantPk,
        amountCents: 25_000n,
        requestId: randomUUID(),
        correlationId: randomUUID(),
      });
      assert.notEqual(first.merchantReference, second.merchantReference);
      assert.notEqual(first.id, second.id);
      assert.equal(first.state, 'awaiting_bank_match');
      assert.equal(second.state, 'awaiting_bank_match');
    });

    await suite.test('cash-in → escrow → cash-out credits agent float', async () => {
      const suffix = randomUUID();
      const senderId = `cs-send-${suffix}`;
      const collectorId = `cs-col-${suffix}`;
      const senderFloat = `cs-sf-${suffix}`;
      const collectorFloat = `cs-cf-${suffix}`;
      const escrowId = `cs-esc-${suffix}`;
      await pool.query(
        `INSERT INTO users
           (id,name,phone,pin_hash,role,kyc_status,account_tier,created_at,country_code,is_system)
         VALUES ($1,'Send',$2,'x','merchant','verified','Basic',clock_timestamp(),'ZA',0),
                ($3,'Col',$4,'x','merchant','verified','Basic',clock_timestamp(),'ZA',1)`,
        [
          senderId,
          `+27${suffix.replaceAll('-', '').slice(0, 9)}`,
          collectorId,
          `+28${suffix.replaceAll('-', '').slice(0, 9)}`,
        ],
      );
      await pool.query(
        `INSERT INTO wallets(id,user_id,balance_cents,currency,status,pool_id,wallet_kind)
         VALUES ($1,$2,10900,'ZAR','active','ZA','merchant_float'),
                ($3,$4,0,'ZAR','active','ZA','merchant_float'),
                ($5,$4,0,'ZAR','active','ZA','system_escrow')`,
        [senderFloat, senderId, collectorFloat, collectorId, escrowId],
      );
      assertWalletKindPair('merchant_float', 'system_escrow', 'cash_send_hold');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await postBetweenWalletsPg(client, {
          fromWalletId: senderFloat,
          toWalletId: escrowId,
          amountCents: 10_900n,
          type: 'cash_send_hold',
          referencePrefix: 'CSH',
          description: `hold-${suffix}`,
        });
        assertWalletKindPair('system_escrow', 'merchant_float', 'cash_send_payout');
        await postBetweenWalletsPg(client, {
          fromWalletId: escrowId,
          toWalletId: collectorFloat,
          amountCents: 10_000n,
          type: 'cash_send_collect',
          referencePrefix: 'CSC',
          description: `collect-${suffix}`,
        });
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      const balances = await pool.query<{ id: string; balance_cents: string }>(
        `SELECT id, balance_cents FROM wallets WHERE id = ANY($1::text[])`,
        [[senderFloat, collectorFloat, escrowId]],
      );
      const byId = Object.fromEntries(balances.rows.map((row) => [row.id, row.balance_cents]));
      assert.equal(byId[senderFloat], '0');
      assert.equal(byId[collectorFloat], '10000');
      assert.equal(byId[escrowId], '900');
    });

    await suite.test('fee lifecycle reverse records R6 platform not R9', async () => {
      const voucherId = randomUUID();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const reversed = await reverseCashSendCreateFeesPg(client, {
          voucherId,
          platformFeeCents: 600n,
          merchantCommissionCents: 100n,
        });
        assert.deepEqual(reversed, createFeeReversalAmounts({
          platformFeeCents: 600n,
          merchantCommissionCents: 100n,
        }));
        const rows = await client.query<{ component: string; amount_cents: string; state: string }>(
          `SELECT component, amount_cents::text, state FROM fee_lifecycle_events
            WHERE source_id = $1 ORDER BY component`,
          [voucherId],
        );
        assert.equal(rows.rows.length, 2);
        const platform = rows.rows.find((row) => row.component === 'platform');
        assert.equal(platform?.amount_cents, '600');
        assert.equal(platform?.state, 'reversed');
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });

    await suite.test('matched consecutive top-ups credit independently', async () => {
      const suffix = randomUUID();
      const userId = `flt2-${suffix}`;
      const merchantPk = `flt2m-${suffix}`;
      const floatId = `flt2w-${suffix}`;
      const escrowUser = `flt2e-${suffix}`;
      const escrowId = `flt2ew-${suffix}`;
      await pool.query(
        `INSERT INTO users
           (id,name,phone,pin_hash,role,kyc_status,account_tier,created_at,country_code,is_system)
         VALUES ($1,'A',$2,'x','merchant','verified','Basic',clock_timestamp(),'ZA',0),
                ($3,'Escrow',$4,'x','system','verified','Basic',clock_timestamp(),'ZA',1)`,
        [
          userId,
          `+27${suffix.replaceAll('-', '').slice(0, 9)}`,
          escrowUser,
          `+29${suffix.replaceAll('-', '').slice(0, 9)}`,
        ],
      );
      await pool.query(
        `INSERT INTO merchants (id, user_id, business_name, location, category, approval_status)
         VALUES ($1,$2,'Shop','ZA','spaza','approved')`,
        [merchantPk, userId],
      );
      await pool.query(
        `INSERT INTO wallets(id,user_id,balance_cents,currency,status,pool_id,wallet_kind)
         VALUES ($1,$2,0,'ZAR','active','ZA','merchant_float'),
                ($3,$4,50000,'ZAR','active','ZA','system_escrow')`,
        [floatId, userId, escrowId, escrowUser],
      );
      const first = await requestFloatTopupPg(pool, {
        merchantUserId: userId,
        merchantId: merchantPk,
        amountCents: 10_000n,
        requestId: randomUUID(),
        correlationId: randomUUID(),
      });
      const second = await requestFloatTopupPg(pool, {
        merchantUserId: userId,
        merchantId: merchantPk,
        amountCents: 20_000n,
        requestId: randomUUID(),
        correlationId: randomUUID(),
      });
      assert.notEqual(first.merchantReference, second.merchantReference);
      await seedApprovedClientFunds(pool);
      const matchFirst = await ingestBankDepositPg(pool, {
        bankReference: `BNK-${suffix}-1`,
        merchantReference: first.merchantReference,
        amountCents: 10_000n,
        currency: 'ZAR',
        direction: 'credit',
        valueDate: new Date().toISOString().slice(0, 10),
        destinationAccount: CLIENT_FUNDS_FINGERPRINT,
      });
      const matchSecond = await ingestBankDepositPg(pool, {
        bankReference: `BNK-${suffix}-2`,
        merchantReference: second.merchantReference,
        amountCents: 20_000n,
        currency: 'ZAR',
        direction: 'credit',
        valueDate: new Date().toISOString().slice(0, 10),
        destinationAccount: CLIENT_FUNDS_FINGERPRINT,
      });
      assert.equal(matchFirst.matchState, 'matched');
      assert.equal(matchSecond.matchState, 'matched');
      const debit = await ingestBankDepositPg(pool, {
        bankReference: `BNK-${suffix}-debit`,
        merchantReference: first.merchantReference,
        amountCents: 10_000n,
        currency: 'ZAR',
        direction: 'debit',
        valueDate: new Date().toISOString().slice(0, 10),
        destinationAccount: CLIENT_FUNDS_FINGERPRINT,
      });
      assert.equal(debit.matchState, 'suspense');
      const reuse = await pool.query(
        `UPDATE merchant_float_topups SET bank_transaction_id = $1 WHERE id = $2`,
        [matchFirst.id, second.id],
      ).catch((error: { code?: string }) => error);
      assert.equal((reuse as { code?: string }).code, '23505');
    });
  },
);
