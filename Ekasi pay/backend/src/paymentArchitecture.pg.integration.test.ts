import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Pool } from 'pg';

import { parseIntegerCents } from './money.js';
import { computeSaleTotals } from './money/saleTotals.js';
import { classifyBankDepositMatch } from './services/bankDepositMatchingPg.js';
import { postBetweenWalletsPg } from './services/walletPostingPg.js';
import { assertWalletKindPair } from './services/walletKindsPg.js';

const connectionString = process.env.TEST_DATABASE_URL;

test(
  'payment architecture postgres: discounted wallet sale, refund, kinds',
  { skip: !connectionString },
  async (suite) => {
    const pool = new Pool({ connectionString, max: 4 });
    suite.after(async () => pool.end());

    await suite.test('R100 gross R10 discount posts R90 and refunds R90', async () => {
      const suffix = randomUUID();
      const customerId = `pay-cust-${suffix}`;
      const merchantUserId = `pay-merch-${suffix}`;
      const customerWallet = `pay-cw-${suffix}`;
      const merchantWallet = `pay-mw-${suffix}`;
      await pool.query(
        `INSERT INTO users
           (id,name,phone,pin_hash,role,kyc_status,account_tier,created_at,country_code,is_system)
         VALUES ($1,'Cust',$2,'x','customer','approved','Basic',clock_timestamp(),'ZA',0),
                ($3,'Merch',$4,'x','merchant','approved','Basic',clock_timestamp(),'ZA',0)`,
        [
          customerId,
          `+27${suffix.replaceAll('-', '').slice(0, 9)}`,
          merchantUserId,
          `+28${suffix.replaceAll('-', '').slice(0, 9)}`,
        ],
      );
      await pool.query(
        `INSERT INTO wallets(id,user_id,balance_cents,currency,status,pool_id,wallet_kind)
         VALUES ($1,$2,20000,'ZAR','active','ZA','user'),
                ($3,$4,0,'ZAR','active','ZA','merchant_sales')`,
        [customerWallet, customerId, merchantWallet, merchantUserId],
      );

      const totals = computeSaleTotals(10_000n, 1_000n);
      assert.equal(totals.netTotalCents, 9_000n);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await postBetweenWalletsPg(client, {
          fromWalletId: customerWallet,
          toWalletId: merchantWallet,
          amountCents: totals.netTotalCents,
          type: 'payment',
          referencePrefix: 'PAY',
          description: `Sale discounted-${suffix}`,
        });
        await client.query('COMMIT');
      } finally {
        client.release();
      }

      const balances = await pool.query<{ user_id: string; balance_cents: string }>(
        `SELECT user_id, balance_cents FROM wallets WHERE id = ANY($1::text[])`,
        [[customerWallet, merchantWallet]],
      );
      const byUser = Object.fromEntries(
        balances.rows.map((row) => [row.user_id, row.balance_cents]),
      );
      assert.equal(byUser[customerId], '11000');
      assert.equal(byUser[merchantUserId], '9000');

      const refundClient = await pool.connect();
      try {
        await refundClient.query('BEGIN');
        await postBetweenWalletsPg(refundClient, {
          fromWalletId: merchantWallet,
          toWalletId: customerWallet,
          amountCents: totals.netTotalCents,
          type: 'refund',
          referencePrefix: 'VOID',
          description: `Void discounted-${suffix}`,
          reversalKind: 'refund',
        });
        await refundClient.query('COMMIT');
      } finally {
        refundClient.release();
      }
      const after = await pool.query<{ user_id: string; balance_cents: string }>(
        `SELECT user_id, balance_cents FROM wallets WHERE id = ANY($1::text[])`,
        [[customerWallet, merchantWallet]],
      );
      const restored = Object.fromEntries(
        after.rows.map((row) => [row.user_id, row.balance_cents]),
      );
      assert.equal(restored[customerId], '20000');
      assert.equal(restored[merchantUserId], '0');
    });

    await suite.test('zero discount and full discount stay exact', () => {
      assert.equal(computeSaleTotals(10_000n, 0n).netTotalCents, 10_000n);
      assert.equal(computeSaleTotals(10_000n, 10_000n).netTotalCents, 0n);
      assert.throws(() => computeSaleTotals(10_000n, 10_001n));
    });

    await suite.test('wallet kinds and bank match stay fail-closed', () => {
      assert.throws(() =>
        assertWalletKindPair('merchant_float', 'user', 'consumer_to_merchant'),
      );
      assert.equal(
        classifyBankDepositMatch({
          exactMatches: 0,
          amountMatches: 1,
          alreadyMatched: false,
        }),
        'partial',
      );
      assert.equal(parseIntegerCents('9000'), 9000n);
    });
  },
);
