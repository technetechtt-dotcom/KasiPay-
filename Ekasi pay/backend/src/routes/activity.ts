import { Router } from 'express';

import { getDb } from '../db.js';
import { toLedgerEntry, toTransaction } from '../mappers.js';
import { requireAuth } from '../middleware/requireAuth.js';

export const activityRouter = Router();

activityRouter.get('/transactions/me', requireAuth, (req, res) => {
  const database = getDb();
  const wallet = database
    .prepare(
      `SELECT id FROM wallets WHERE user_id = ? AND COALESCE(wallet_kind, 'user') = 'user'`
    )
    .get(req.auth!.userId) as { id: string } | undefined;
  if (!wallet) {
    return res.json({ transactions: [] });
  }
  const rows = database
    .prepare(
      `SELECT * FROM transactions
       WHERE from_wallet_id = ? OR to_wallet_id = ?
       ORDER BY datetime(created_at) DESC
       LIMIT 200`
    )
    .all(wallet.id, wallet.id) as {
    id: string;
    from_wallet_id: string | null;
    to_wallet_id: string | null;
    amount: number;
    type: string;
    status: string;
    reference: string;
    description: string;
    created_at: string;
  }[];
  return res.json({ transactions: rows.map(toTransaction) });
});

activityRouter.get('/ledger/me', requireAuth, (req, res) => {
  const database = getDb();
  const wallet = database
    .prepare(
      `SELECT id FROM wallets WHERE user_id = ? AND COALESCE(wallet_kind, 'user') = 'user'`
    )
    .get(req.auth!.userId) as { id: string } | undefined;
  if (!wallet) {
    return res.json({ ledger: [] });
  }
  const rows = database
    .prepare(
      `SELECT * FROM ledger_entries
       WHERE account_id = ?
       ORDER BY datetime(created_at) DESC
       LIMIT 300`
    )
    .all(wallet.id) as {
    id: string;
    transaction_id: string;
    account_id: string;
    entry_type: string;
    amount: number;
    balance_after: number;
    created_at: string;
  }[];
  return res.json({ ledger: rows.map(toLedgerEntry) });
});
