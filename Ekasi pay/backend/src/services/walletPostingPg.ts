import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

type DbClient = Pool | PoolClient;

async function walletDebit(
  database: DbClient,
  walletId: string,
  amount: number,
): Promise<number> {
  const debit = await database.query<{ balance: number }>(
    `UPDATE wallets
        SET balance = balance - $1
      WHERE id = $2
        AND status = 'active'
        AND balance >= $1
      RETURNING balance`,
    [amount, walletId],
  );
  if (debit.rows[0]) {
    return debit.rows[0].balance;
  }

  const check = await database.query<{ balance: number; status: string }>(
    `SELECT balance, status FROM wallets WHERE id = $1`,
    [walletId],
  );
  const row = check.rows[0];
  if (!row) {
    throw Object.assign(new Error('Wallet missing'), { status: 400 });
  }
  if (row.status !== 'active') {
    throw Object.assign(new Error('Wallet inactive'), { status: 400 });
  }
  throw Object.assign(new Error('Insufficient balance'), { status: 400 });
}

async function walletCredit(
  database: DbClient,
  walletId: string,
  amount: number,
): Promise<number> {
  const credit = await database.query<{ balance: number }>(
    `UPDATE wallets
        SET balance = balance + $1
      WHERE id = $2
        AND status = 'active'
      RETURNING balance`,
    [amount, walletId],
  );
  const row = credit.rows[0];
  if (!row) {
    throw Object.assign(new Error('Destination wallet unavailable'), {
      status: 400,
    });
  }
  return row.balance;
}

/**
 * Atomic wallet-to-wallet posting with mirrored `transactions` + `ledger_entries`.
 * Uses conditional UPDATE so concurrent debits cannot overdraw the source wallet.
 */
export async function postBetweenWalletsPg(
  database: DbClient,
  opts: {
    fromWalletId: string;
    toWalletId: string;
    amount: number;
    type: string;
    referencePrefix: string;
    description: string;
  },
): Promise<{ transactionId: string; reference: string }> {
  const { fromWalletId, toWalletId, amount, type, referencePrefix, description } =
    opts;
  if (amount <= 0 || !Number.isFinite(amount)) {
    throw Object.assign(new Error('Invalid amount'), { status: 400 });
  }
  if (fromWalletId === toWalletId) {
    throw Object.assign(new Error('Cannot move to the same wallet'), {
      status: 400,
    });
  }

  const fromBalanceAfter = await walletDebit(database, fromWalletId, amount);
  const toBalanceAfter = await walletCredit(database, toWalletId, amount);

  const txnId = randomUUID();
  const now = new Date().toISOString();
  const reference = `${referencePrefix}-${txnId.slice(0, 8).toUpperCase()}`;
  const ledgerDebitId = randomUUID();
  const ledgerCreditId = randomUUID();

  await database.query(
    `INSERT INTO transactions (id, from_wallet_id, to_wallet_id, amount, type, status, reference, description, created_at)
     VALUES ($1, $2, $3, $4, $5, 'completed', $6, $7, $8)`,
    [
      txnId,
      fromWalletId,
      toWalletId,
      amount,
      type,
      reference,
      description,
      now,
    ],
  );

  await database.query(
    `INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount, balance_after, created_at)
     VALUES ($1, $2, $3, 'debit', $4, $5, $6)`,
    [ledgerDebitId, txnId, fromWalletId, amount, fromBalanceAfter, now],
  );

  await database.query(
    `INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount, balance_after, created_at)
     VALUES ($1, $2, $3, 'credit', $4, $5, $6)`,
    [ledgerCreditId, txnId, toWalletId, amount, toBalanceAfter, now],
  );

  return { transactionId: txnId, reference };
}
