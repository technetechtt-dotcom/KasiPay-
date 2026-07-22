import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import pg from 'pg';

if (process.env.ALLOW_LEDGER_BACKFILL !== '1' || !process.env.LEDGER_BACKFILL_APPROVAL?.trim()) {
  throw new Error(
    'Refusing ledger backfill. Set ALLOW_LEDGER_BACKFILL=1 and LEDGER_BACKFILL_APPROVAL to the written approval reference.',
  );
}
const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) throw new Error('DATABASE_URL is required.');
const url = new URL(connectionString);
const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
const client = new pg.Client({
  connectionString,
  ssl: local
    ? false
    : { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED !== 'false' },
});

await client.connect();
try {
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  const gate = await client.query(
    `SELECT state, legacy_transactions FROM ledger_backfill_status WHERE id = 1 FOR UPDATE`,
  );
  if (gate.rows[0]?.state !== 'pending_signoff') {
    throw new Error(`Backfill state is ${gate.rows[0]?.state ?? 'missing'}, expected pending_signoff.`);
  }
  const existing = await client.query(`SELECT count(*)::int count FROM journal_transactions`);
  if (existing.rows[0].count !== 0) {
    throw new Error('Journal is not empty; an operator-authored conversion is required.');
  }
  const wallets = await client.query(
    `SELECT id, balance_cents, currency, COALESCE(pool_id, 'ZA') pool_id
       FROM wallets ORDER BY id FOR UPDATE`,
  );
  const batchId = randomUUID();
  await client.query(
    `INSERT INTO posting_batches(id,source,actor_id,state)
     VALUES ($1,'legacy_opening_balance',$2,'authorized')`,
    [batchId, process.env.LEDGER_BACKFILL_APPROVAL],
  );
  let total = 0n;
  let posted = 0;
  for (const wallet of wallets.rows) {
    const amount = BigInt(wallet.balance_cents);
    if (amount < 0n) throw new Error(`Legacy wallet ${wallet.id} has a negative balance.`);
    const accountId = `wallet:${wallet.id}`;
    await client.query(
      `INSERT INTO ledger_accounts
        (id,code,name,account_class,normal_side,currency,pool_id,wallet_id)
       VALUES ($1,$2,$3,'liability','credit',$4,$5,$6)`,
      [accountId, `WALLET-${wallet.id}`, `Wallet ${wallet.id}`, wallet.currency, wallet.pool_id, wallet.id],
    );
    await client.query(
      `INSERT INTO account_balance_projections(account_id,available_cents) VALUES ($1,0)`,
      [accountId],
    );
    if (amount === 0n) continue;
    if (wallet.currency !== 'ZAR' || wallet.pool_id !== 'ZA') {
      throw new Error(`No approved opening suspense account for ${wallet.currency}/${wallet.pool_id}.`);
    }
    const transactionId = randomUUID();
    const reference = `OPEN-${transactionId.slice(0, 8).toUpperCase()}`;
    await client.query(
      `INSERT INTO journal_transactions
        (id,batch_id,reference,transaction_type,description,currency,pool_id,state,
         effective_at,posted_at,metadata)
       VALUES ($1,$2,$3,'opening_balance',$4,$5,$6,'posted',
               clock_timestamp(),clock_timestamp(),$7::jsonb)`,
      [
        transactionId,
        batchId,
        reference,
        `Approved legacy opening balance for wallet ${wallet.id}`,
        wallet.currency,
        wallet.pool_id,
        JSON.stringify({ approval: process.env.LEDGER_BACKFILL_APPROVAL }),
      ],
    );
    await client.query(
      `INSERT INTO journal_entries(id,transaction_id,account_id,side,amount_cents,currency)
       VALUES ($1,$2,'system:suspense:zar','debit',$3,$4),
              ($5,$2,$6,'credit',$3,$4)`,
      [randomUUID(), transactionId, amount.toString(), wallet.currency, randomUUID(), accountId],
    );
    await client.query(
      `UPDATE account_balance_projections
          SET available_cents = available_cents - $1, version = version + 1
        WHERE account_id = 'system:suspense:zar'`,
      [amount.toString()],
    );
    await client.query(
      `UPDATE account_balance_projections
          SET available_cents = available_cents + $1, version = version + 1
        WHERE account_id = $2`,
      [amount.toString(), accountId],
    );
    total += amount;
    posted += 1;
  }
  await client.query(
    `UPDATE posting_batches SET state='posted', posted_at=clock_timestamp() WHERE id=$1`,
    [batchId],
  );
  await client.query(
    `UPDATE ledger_backfill_status
      SET state='completed', completed_at=clock_timestamp(), checked_at=clock_timestamp(),
          report=$1::jsonb
    WHERE id=1`,
    [
      JSON.stringify({
        approval: process.env.LEDGER_BACKFILL_APPROVAL,
        walletCount: wallets.rowCount,
        postedWalletCount: posted,
        openingCents: total.toString(),
      }),
    ],
  );
  await client.query('COMMIT');
  console.log(JSON.stringify({ postedWalletCount: posted, openingCents: total.toString() }));
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
