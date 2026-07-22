import { Router } from 'express';

import { getPgPool } from '../dbPg.js';
import { toLedgerEntry, toTransaction } from '../mappers.js';
import { requireAuth } from '../middleware/requireAuth.js';

export const activityRouterPg = Router();

activityRouterPg.get('/transactions/me', requireAuth, async (req, res) => {
  const pool = getPgPool();
  const walletQ = await pool.query<{ id: string }>(
    `SELECT id
       FROM wallets
      WHERE user_id = $1
        AND COALESCE(wallet_kind, 'user') = 'user'`,
    [req.auth!.userId],
  );
  const wallet = walletQ.rows[0];
  if (!wallet) return res.json({ transactions: [] });

  const rows = await pool.query<{
    id: string;
    from_wallet_id: string | null;
    to_wallet_id: string | null;
    amount_cents: string;
    type: string;
    status: string;
    reference: string;
    description: string;
    created_at: string;
  }>(
    `SELECT id, from_wallet_id, to_wallet_id, amount_cents, type, status,
            reference, description, created_at
       FROM transactions
      WHERE from_wallet_id = $1 OR to_wallet_id = $1
      ORDER BY created_at DESC
      LIMIT 200`,
    [wallet.id],
  );
  return res.json({ transactions: rows.rows.map(toTransaction) });
});

activityRouterPg.get('/ledger/me', requireAuth, async (req, res) => {
  const pool = getPgPool();
  const walletQ = await pool.query<{ id: string }>(
    `SELECT id
       FROM wallets
      WHERE user_id = $1
        AND COALESCE(wallet_kind, 'user') = 'user'`,
    [req.auth!.userId],
  );
  const wallet = walletQ.rows[0];
  if (!wallet) return res.json({ ledger: [] });

  const rows = await pool.query<{
    id: string;
    transaction_id: string;
    account_id: string;
    entry_type: string;
    amount_cents: string;
    balance_after_cents: string;
    created_at: string;
  }>(
    `SELECT id, transaction_id, account_id, entry_type, amount_cents,
            balance_after_cents, created_at
       FROM ledger_entries
      WHERE account_id = $1
      ORDER BY created_at DESC
      LIMIT 300`,
    [wallet.id],
  );
  return res.json({ ledger: rows.rows.map(toLedgerEntry) });
});
