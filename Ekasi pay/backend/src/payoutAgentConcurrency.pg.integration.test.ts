/**
 * 10 concurrent cash-out reservations against one payout agent near its daily limit.
 * Opt-in: PG_INTEGRATION_TESTS=1 TEST_DATABASE_URL=... npm run test:postgres
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Pool } from 'pg';

import { declareCashLiquidityPg } from './services/cashAvailabilityPg.js';
import { lockAndReservePayoutCapacityPg } from './services/payoutAgentsPg.js';

const enabled = process.env.PG_INTEGRATION_TESTS === '1';
const connectionString = process.env.TEST_DATABASE_URL?.trim() || '';

test(
  'payout agent daily-limit concurrency',
  { skip: !enabled || !connectionString },
  async (suite) => {
    const pool = new Pool({ connectionString, max: 12 });
    suite.after(async () => pool.end());

    await suite.test(
      '10 simultaneous cash-outs against one agent near its daily limit',
      async () => {
        const suffix = randomUUID();
        const userId = `pay-user-${suffix}`;
        const merchantPk = `pay-merch-${suffix}`;
        const amount = 10_000n;
        await pool.query(
          `INSERT INTO users
             (id,name,phone,pin_hash,role,kyc_status,account_tier,created_at,country_code,is_system)
           VALUES ($1,'Pay',$2,'x','merchant','verified','Basic',clock_timestamp(),'ZA',0)`,
          [userId, `+27${suffix.replaceAll('-', '').slice(0, 9)}`],
        );
        await pool.query(
          `INSERT INTO merchants (id, user_id, business_name, location, category, approval_status)
           VALUES ($1,$2,'Pay Shop','ZA','spaza','approved')`,
          [merchantPk, userId],
        );
        await pool.query(
          `INSERT INTO merchant_activations (id, merchant_id, status)
           VALUES ($1,$2,'complete')`,
          [randomUUID(), userId],
        );
        await pool.query(
          `INSERT INTO wallets(id,user_id,balance_cents,currency,status,pool_id,wallet_kind)
           VALUES ($1,$2,0,'ZAR','active','ZA','merchant_float')`,
          [`pay-float-${suffix}`, userId],
        );
        await pool.query(
          `INSERT INTO payout_agents
             (merchant_id, status, float_floor_cents, per_transaction_limit_cents,
              daily_payout_limit_cents, enrolled_at)
           VALUES ($1,'enrolled',0,$2,$3,clock_timestamp())`,
          [userId, amount.toString(), (amount * 5n).toString()],
        );
        await declareCashLiquidityPg(pool, merchantPk, 1_000_000n);

        const attempts = Array.from({ length: 10 }, () => randomUUID());
        const results = await Promise.all(
          attempts.map(async (voucherId) => {
            const client = await pool.connect();
            try {
              await client.query('BEGIN');
              await lockAndReservePayoutCapacityPg(client, userId, amount, voucherId);
              await client.query('COMMIT');
              return 'ok';
            } catch {
              await client.query('ROLLBACK');
              return 'fail';
            } finally {
              client.release();
            }
          }),
        );
        assert.equal(results.filter((row) => row === 'ok').length, 5);
        assert.equal(results.filter((row) => row === 'fail').length, 5);
        const used = await pool.query<{ daily_payout_used_cents: string }>(
          `SELECT daily_payout_used_cents FROM payout_agents WHERE merchant_id = $1`,
          [userId],
        );
        assert.equal(used.rows[0].daily_payout_used_cents, (amount * 5n).toString());
      },
    );
  },
);
