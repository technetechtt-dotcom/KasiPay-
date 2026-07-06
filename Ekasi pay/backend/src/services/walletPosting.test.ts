import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { postBetweenWallets } from './walletPosting.js';

/**
 * Boots an in-memory DB with the minimum schema `postBetweenWallets` reads
 * and writes. Mirrors the real schema in db.ts (just the tables we need)
 * so the assertions are exactly what production sees.
 */
function bootDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE wallets (
      id TEXT PRIMARY KEY,
      balance REAL NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE transactions (
      id TEXT PRIMARY KEY,
      from_wallet_id TEXT,
      to_wallet_id TEXT,
      amount REAL NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      reference TEXT NOT NULL,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE ledger_entries (
      id TEXT PRIMARY KEY,
      transaction_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      entry_type TEXT NOT NULL,
      amount REAL NOT NULL,
      balance_after REAL NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  db.prepare(`INSERT INTO wallets (id, balance, status) VALUES (?, ?, ?)`).run(
    'w-from',
    200,
    'active',
  );
  db.prepare(`INSERT INTO wallets (id, balance, status) VALUES (?, ?, ?)`).run(
    'w-to',
    50,
    'active',
  );
  return db;
}

function getWallet(db: Database.Database, id: string) {
  return db
    .prepare('SELECT id, balance, status FROM wallets WHERE id = ?')
    .get(id) as { id: string; balance: number; status: string };
}

describe('postBetweenWallets', () => {
  it('moves funds atomically and writes mirrored ledger entries', () => {
    const db = bootDb();
    postBetweenWallets(db, {
      fromWalletId: 'w-from',
      toWalletId: 'w-to',
      amount: 75,
      type: 'transfer',
      referencePrefix: 'TST',
      description: 'unit test transfer',
    });

    assert.equal(getWallet(db, 'w-from').balance, 125);
    assert.equal(getWallet(db, 'w-to').balance, 125);

    const txns = db
      .prepare('SELECT * FROM transactions')
      .all() as { amount: number; type: string; status: string }[];
    assert.equal(txns.length, 1);
    assert.equal(txns[0].amount, 75);
    assert.equal(txns[0].status, 'completed');

    const ledger = db
      .prepare('SELECT entry_type, amount, balance_after FROM ledger_entries ORDER BY entry_type')
      .all() as { entry_type: string; amount: number; balance_after: number }[];
    assert.equal(ledger.length, 2);
    const credit = ledger.find((l) => l.entry_type === 'credit')!;
    const debit = ledger.find((l) => l.entry_type === 'debit')!;
    assert.equal(credit.amount, 75);
    assert.equal(debit.amount, 75);
    assert.equal(credit.balance_after, 125);
    assert.equal(debit.balance_after, 125);
  });

  it('rejects zero / NaN / negative amounts with a 400-flavored error', () => {
    const db = bootDb();
    for (const amount of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () =>
          postBetweenWallets(db, {
            fromWalletId: 'w-from',
            toWalletId: 'w-to',
            amount,
            type: 'transfer',
            referencePrefix: 'TST',
            description: 'invalid',
          }),
        (err: unknown) => {
          const e = err as { status?: number; message?: string };
          assert.equal(e.status, 400);
          return true;
        },
      );
    }
  });

  it('rejects same-wallet postings', () => {
    const db = bootDb();
    assert.throws(
      () =>
        postBetweenWallets(db, {
          fromWalletId: 'w-from',
          toWalletId: 'w-from',
          amount: 10,
          type: 'transfer',
          referencePrefix: 'TST',
          description: 'self',
        }),
      /same wallet/i,
    );
  });

  it('refuses to debit a wallet with insufficient balance', () => {
    const db = bootDb();
    assert.throws(
      () =>
        postBetweenWallets(db, {
          fromWalletId: 'w-from',
          toWalletId: 'w-to',
          amount: 9999,
          type: 'transfer',
          referencePrefix: 'TST',
          description: 'overspend',
        }),
      /insufficient/i,
    );
    // No partial writes should remain.
    assert.equal(getWallet(db, 'w-from').balance, 200);
    assert.equal(getWallet(db, 'w-to').balance, 50);
    const txns = db.prepare('SELECT COUNT(*) as c FROM transactions').get() as { c: number };
    assert.equal(txns.c, 0);
  });

  it('refuses to credit / debit an inactive wallet', () => {
    const db = bootDb();
    db.prepare(`UPDATE wallets SET status = 'frozen' WHERE id = 'w-to'`).run();
    assert.throws(
      () =>
        postBetweenWallets(db, {
          fromWalletId: 'w-from',
          toWalletId: 'w-to',
          amount: 5,
          type: 'transfer',
          referencePrefix: 'TST',
          description: 'frozen',
        }),
      /inactive/i,
    );
  });
});
