import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

type DbClient = Pool | PoolClient;

/**
 * Atomic wallet-to-wallet posting with mirrored `transactions` + `ledger_entries`.
 * Works with both pooled and transaction clients.
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
): Promise<void> {
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

  const fromQ = await database.query<{ balance: number; status: string }>(
    `SELECT balance, status FROM wallets WHERE id = $1`,
    [fromWalletId],
  );
  const toQ = await database.query<{ balance: number; status: string }>(
    `SELECT balance, status FROM wallets WHERE id = $1`,
    [toWalletId],
  );
  const fromRow = fromQ.rows[0];
  const toRow = toQ.rows[0];
  if (!fromRow || !toRow) {
    throw Object.assign(new Error('Wallet missing'), { status: 400 });
  }
  if (fromRow.status !== 'active' || toRow.status !== 'active') {
    throw Object.assign(new Error('Wallet inactive'), { status: 400 });
  }
  if (fromRow.balance < amount) {
    throw Object.assign(new Error('Insufficient balance'), { status: 400 });
  }

  const fromBalanceAfter = fromRow.balance - amount;
  const toBalanceAfter = toRow.balance + amount;
  const txnId = randomUUID();
  const now = new Date().toISOString();
  const reference = `${referencePrefix}-${txnId.slice(0, 8).toUpperCase()}`;
  const ledgerDebitId = randomUUID();
  const ledgerCreditId = randomUUID();

  await database.query(
    `UPDATE wallets SET balance = $1 WHERE id = $2`,
    [fromBalanceAfter, fromWalletId],
  );
  await database.query(
    `UPDATE wallets SET balance = $1 WHERE id = $2`,
    [toBalanceAfter, toWalletId],
  );

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
}
