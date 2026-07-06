import { Router } from 'express';

import { getPgPool } from '../dbPg.js';
import { toWallet } from '../mappers.js';
import { requireAuth } from '../middleware/requireAuth.js';

export const walletsRouterPg = Router();

walletsRouterPg.get('/wallets/me', requireAuth, async (req, res) => {
  const pool = getPgPool();
  const q = await pool.query<{
    id: string;
    user_id: string;
    balance: number;
    currency: string;
    status: string;
    pool_id: string;
    wallet_kind: string;
  }>(
    `SELECT * FROM wallets
      WHERE user_id = $1 AND COALESCE(wallet_kind, 'user') = 'user'`,
    [req.auth!.userId],
  );
  const row = q.rows[0];
  if (!row) {
    return res.status(404).json({ error: 'Wallet not found' });
  }
  return res.json({ wallet: toWallet(row) });
});
