import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

/**
 * Atomic wallet-to-wallet posting with mirrored `transactions` + `ledger_entries`
 * rows (matches `POST /transfers` shape). Intended for escrow legs.
 */
export function postBetweenWallets(
  database: Database.Database,
  opts: {
    fromWalletId: string;
    toWalletId: string;
    amount: number;
    type: string;
    referencePrefix: string;
    description: string;
  }
): void {
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

  const fromRow = database
    .prepare('SELECT balance, status FROM wallets WHERE id = ?')
    .get(fromWalletId) as { balance: number; status: string } | undefined;
  const toRow = database
    .prepare('SELECT balance, status FROM wallets WHERE id = ?')
    .get(toWalletId) as { balance: number; status: string } | undefined;

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

  database.prepare('UPDATE wallets SET balance = ? WHERE id = ?').run(fromBalanceAfter, fromWalletId);
  database.prepare('UPDATE wallets SET balance = ? WHERE id = ?').run(toBalanceAfter, toWalletId);

  database
    .prepare(
      `INSERT INTO transactions (id, from_wallet_id, to_wallet_id, amount, type, status, reference, description, created_at)
       VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?)`
    )
    .run(
      txnId,
      fromWalletId,
      toWalletId,
      amount,
      type,
      reference,
      description,
      now
    );

  database
    .prepare(
      `INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount, balance_after, created_at)
       VALUES (?, ?, ?, 'debit', ?, ?, ?)`
    )
    .run(ledgerDebitId, txnId, fromWalletId, amount, fromBalanceAfter, now);

  database
    .prepare(
      `INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount, balance_after, created_at)
       VALUES (?, ?, ?, 'credit', ?, ?, ?)`
    )
    .run(ledgerCreditId, txnId, toWalletId, amount, toBalanceAfter, now);
}
