import { Router } from 'express';

import { getDb } from '../db.js';
import { toWallet } from '../mappers.js';
import { requireAuth } from '../middleware/requireAuth.js';

export const walletsRouter = Router();

walletsRouter.get('/wallets/me', requireAuth, (req, res) => {
  const database = getDb();
  const row = database
    .prepare(
      `SELECT * FROM wallets WHERE user_id = ? AND COALESCE(wallet_kind, 'user') = 'user'`
    )
    .get(req.auth!.userId) as
    | {
        id: string;
        user_id: string;
        balance: number;
        currency: string;
        status: string;
      }
    | undefined;
  if (!row) {
    return res.status(404).json({ error: 'Wallet not found' });
  }
  return res.json({ wallet: toWallet(row) });
});
