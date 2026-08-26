import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Pool } from 'pg';

import { ingestBankDepositPg } from './services/bankDepositMatchingPg.js';
import { settleBankTransactionPg } from './services/bankTransactionLifecyclePg.js';
import { creditMatchedFloatTopupPg, requestFloatTopupPg } from './services/merchantFloatPg.js';

const CLIENT_FUNDS_FINGERPRINT = 'TEST-CLIENT-FUNDS-ZA-ZAR';
const connectionString = process.env.TEST_DATABASE_URL;
const enabled = process.env.PG_INTEGRATION_TESTS === '1' && Boolean(connectionString);

test('bank transaction finality postgres', { skip: !enabled }, async (suite) => {
  const pool = new Pool({ connectionString, max: 4 });
  suite.after(async () => pool.end());

  await suite.test('matched pending EFTs cannot credit float until settled', async () => {
    const suffix = randomUUID();
    const userId = `final-user-${suffix}`;
    const merchantPk = `final-merch-${suffix}`;
    await pool.query(
      `INSERT INTO users
         (id,name,phone,pin_hash,role,kyc_status,account_tier,created_at,country_code,is_system)
       VALUES ($1,'Final',$2,'x','merchant','verified','Basic',clock_timestamp(),'ZA',0)`,
      [userId, `+27${suffix.replaceAll('-', '').slice(0, 9)}`],
    );
    await pool.query(
      `INSERT INTO merchants (id, user_id, business_name, location, category, approval_status)
       VALUES ($1,$2,'Final Shop','ZA','spaza','approved')`,
      [merchantPk, userId],
    );
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
    const topup = await requestFloatTopupPg(pool, {
      merchantUserId: userId,
      merchantId: merchantPk,
      amountCents: 5_000n,
      requestId: randomUUID(),
      correlationId: randomUUID(),
    });
    const ingested = await ingestBankDepositPg(pool, {
      bankReference: `BNK-FINAL-${suffix}`,
      merchantReference: topup.merchantReference,
      amountCents: 5_000n,
      currency: 'ZAR',
      direction: 'credit',
      valueDate: new Date().toISOString().slice(0, 10),
      destinationAccount: CLIENT_FUNDS_FINGERPRINT,
    });
    assert.equal(ingested.matchState, 'matched');
    const lifecycle = await pool.query<{ lifecycle_status: string }>(
      `SELECT lifecycle_status FROM bank_transactions WHERE id = $1`,
      [ingested.id],
    );
    assert.equal(lifecycle.rows[0]?.lifecycle_status, 'received');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await creditMatchedFloatTopupPg(client, { topupId: topup.id, actorId: 'ops-test' }).then(
        () => {
          throw new Error('credited before settlement');
        },
        (error: { code?: string }) => {
          assert.equal(error.code, 'BANK_NOT_SETTLED');
        },
      );
      await settleBankTransactionPg(client, {
        bankTransactionId: ingested.id,
        actorId: 'ops-test',
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const settled = await pool.query<{ lifecycle_status: string }>(
      `SELECT lifecycle_status FROM bank_transactions WHERE id = $1`,
      [ingested.id],
    );
    assert.equal(settled.rows[0]?.lifecycle_status, 'settled');
  });
});
