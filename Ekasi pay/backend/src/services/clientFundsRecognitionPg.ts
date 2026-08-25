import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { parseIntegerCents, type Cents } from '../money.js';
import { clientFundsBankLedgerAccountId } from './clientFundsAccountsPg.js';

async function ensureWalletLedgerAccount(
  database: PoolClient,
  wallet: { id: string; currency: string; pool_id: string; balance_cents: string },
): Promise<string> {
  const id = `wallet:${wallet.id}`;
  await database.query(
    `INSERT INTO ledger_accounts
       (id, code, name, account_class, normal_side, currency, pool_id, wallet_id)
     VALUES ($1, $2, $3, 'liability', 'credit', $4, $5, $6)
     ON CONFLICT (wallet_id) DO NOTHING`,
    [id, `WALLET-${wallet.id}`, `Wallet ${wallet.id}`, wallet.currency, wallet.pool_id, wallet.id],
  );
  const resolved = await database.query<{ id: string }>(
    `SELECT id FROM ledger_accounts WHERE wallet_id = $1`,
    [wallet.id],
  );
  const resolvedId = resolved.rows[0]?.id;
  if (!resolvedId) throw new Error(`Ledger account missing for wallet ${wallet.id}`);
  await database.query(
    `INSERT INTO account_balance_projections(account_id, available_cents)
     VALUES ($1, $2) ON CONFLICT (account_id) DO NOTHING`,
    [resolvedId, wallet.balance_cents],
  );
  return resolvedId;
}

/**
 * Dr safeguarded client-funds bank asset / Cr regional escrow liability,
 * then increase the escrow wallet so the subsequent float credit has funds.
 */
export async function recognizeClientFundsBankCreditPg(
  database: PoolClient,
  input: {
    escrowWalletId: string;
    amountCents: Cents;
    currency: string;
    poolId: string;
    bankTransactionId: string;
    actorId: string;
  },
): Promise<{ transactionId: string; reference: string }> {
  const amount = parseIntegerCents(input.amountCents);
  const bankAccountId = clientFundsBankLedgerAccountId(input.poolId, input.currency);
  const escrow = await database.query<{
    id: string;
    balance_cents: string;
    currency: string;
    pool_id: string;
    status: string;
  }>(
    `SELECT id, balance_cents, currency, COALESCE(pool_id, 'ZA') AS pool_id, status
       FROM wallets WHERE id = $1 FOR UPDATE`,
    [input.escrowWalletId],
  );
  const wallet = escrow.rows[0];
  if (!wallet || wallet.status !== 'active') {
    throw Object.assign(new Error('Regional escrow is not available'), { status: 503 });
  }
  if (wallet.currency !== input.currency || wallet.pool_id !== input.poolId) {
    throw Object.assign(new Error('Escrow currency/pool mismatch'), { status: 400 });
  }

  await database.query(
    `INSERT INTO ledger_accounts
       (id, code, name, account_class, normal_side, currency, pool_id, allow_negative)
     VALUES ($1, $2, $3, 'asset', 'debit', $4, $5, FALSE)
     ON CONFLICT (id) DO NOTHING`,
    [
      bankAccountId,
      `1000-CF-${input.poolId}-${input.currency}`,
      `Client funds bank ${input.poolId} ${input.currency}`,
      input.currency,
      input.poolId,
    ],
  );
  await database.query(
    `INSERT INTO account_balance_projections(account_id, available_cents)
     VALUES ($1, 0) ON CONFLICT (account_id) DO NOTHING`,
    [bankAccountId],
  );

  const escrowAccountId = await ensureWalletLedgerAccount(database, wallet);
  await database.query(
    `SELECT account_id FROM account_balance_projections
      WHERE account_id = ANY($1::text[]) ORDER BY account_id FOR UPDATE`,
    [[bankAccountId, escrowAccountId].sort()],
  );

  const transactionId = randomUUID();
  const batchId = randomUUID();
  const reference = `CFR-${transactionId.slice(0, 8).toUpperCase()}`;
  const now = new Date().toISOString();
  await database.query(
    `INSERT INTO posting_batches(id, source, actor_id, state)
     VALUES ($1, 'client_funds_bank_recognition', $2, 'authorized')`,
    [batchId, input.actorId],
  );
  await database.query(
    `INSERT INTO journal_transactions
       (id, batch_id, reference, transaction_type, description, currency, pool_id,
        state, effective_at, metadata)
     VALUES ($1,$2,$3,'client_funds_bank_recognition',$4,$5,$6,'authorized',$7,$8::jsonb)`,
    [
      transactionId,
      batchId,
      reference,
      `Client-funds bank credit ${input.bankTransactionId}`,
      input.currency,
      input.poolId,
      now,
      JSON.stringify({ bankTransactionId: input.bankTransactionId }),
    ],
  );
  await database.query(
    `INSERT INTO journal_entries(id, transaction_id, account_id, side, amount_cents, currency)
     VALUES ($1,$2,$3,'debit',$4,$5), ($6,$2,$7,'credit',$4,$5)`,
    [
      randomUUID(),
      transactionId,
      bankAccountId,
      amount.toString(),
      input.currency,
      randomUUID(),
      escrowAccountId,
    ],
  );
  await database.query(
    `UPDATE account_balance_projections
        SET available_cents = available_cents + $1, version = version + 1,
            updated_at = clock_timestamp()
      WHERE account_id = $2`,
    [amount.toString(), bankAccountId],
  );
  const credited = await database.query<{ available_cents: string }>(
    `UPDATE account_balance_projections
        SET available_cents = available_cents + $1, version = version + 1,
            updated_at = clock_timestamp()
      WHERE account_id = $2
      RETURNING available_cents`,
    [amount.toString(), escrowAccountId],
  );
  await database.query(`UPDATE wallets SET balance_cents = balance_cents + $1 WHERE id = $2`, [
    amount.toString(),
    wallet.id,
  ]);
  await database.query(
    `INSERT INTO ledger_entries
       (id, transaction_id, account_id, entry_type, amount_cents, balance_after_cents, created_at)
     VALUES ($1,$2,$3,'credit',$4,$5,$6)`,
    [
      randomUUID(),
      transactionId,
      wallet.id,
      amount.toString(),
      credited.rows[0]?.available_cents ?? '0',
      now,
    ],
  );
  await database.query(
    `UPDATE journal_transactions SET state = 'posted', posted_at = $2 WHERE id = $1`,
    [transactionId, now],
  );
  await database.query(
    `UPDATE posting_batches SET state = 'posted', posted_at = $2 WHERE id = $1`,
    [batchId, now],
  );
  return { transactionId, reference };
}
