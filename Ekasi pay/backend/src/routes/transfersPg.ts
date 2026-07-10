import { Router } from 'express';

import { getPgPool } from '../dbPg.js';
import { toTransaction } from '../mappers.js';
import { idempotentPg } from '../middleware/idempotencyPg.js';
import { requireApprovedMerchant } from '../middleware/requireApprovedMerchant.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { DEFAULT_POOL_ID } from '../poolConstants.js';
import { createComplianceFlagPg } from '../services/compliancePg.js';
import { postBetweenWalletsPg } from '../services/walletPostingPg.js';
import { transferBodySchema } from '../validation.js';

export const transfersRouterPg = Router();

transfersRouterPg.use(requireAuth, requireApprovedMerchant);

transfersRouterPg.post(
  '/transfers',
  requireAuth,
  idempotentPg('POST /transfers'),
  async (req, res) => {
    const parsed = transferBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const { toPhone, amount, description } = parsed.data;
    const pool = getPgPool();
    const fromUserId = req.auth!.userId;

    if (toPhone === req.auth!.phone) {
      return res.status(400).json({ error: 'Cannot transfer to the same phone' });
    }

    const fromWalletQ = await pool.query<{
      id: string;
      status: string;
      pool_id: string | null;
    }>(
      `SELECT id, status, pool_id FROM wallets
       WHERE user_id = $1 AND COALESCE(wallet_kind, 'user') = 'user'`,
      [fromUserId],
    );
    const fromWallet = fromWalletQ.rows[0];
    if (!fromWallet) return res.status(404).json({ error: 'Wallet not found' });
    if (fromWallet.status !== 'active') {
      return res.status(400).json({ error: 'Wallet is not active' });
    }

    const toUserQ = await pool.query<{ id: string }>(
      `SELECT id FROM users WHERE phone = $1 AND COALESCE(is_system, 0) = 0`,
      [toPhone],
    );
    const toUser = toUserQ.rows[0];
    if (!toUser) return res.status(404).json({ error: 'Recipient not found' });

    const toWalletQ = await pool.query<{
      id: string;
      status: string;
      pool_id: string | null;
    }>(
      `SELECT id, status, pool_id FROM wallets
       WHERE user_id = $1 AND COALESCE(wallet_kind, 'user') = 'user'`,
      [toUser.id],
    );
    const toWallet = toWalletQ.rows[0];
    if (!toWallet) {
      return res.status(404).json({ error: 'Recipient wallet not found' });
    }
    if (toWallet.status !== 'active') {
      return res.status(400).json({ error: 'Recipient wallet is not active' });
    }

    const fromPool = fromWallet.pool_id ?? DEFAULT_POOL_ID;
    const toPool = toWallet.pool_id ?? DEFAULT_POOL_ID;
    if (fromPool !== toPool) {
      return res.status(400).json({
        error:
          'Cross-country transfers are not supported yet — recipient must use the same region as you.',
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const posted = await postBetweenWalletsPg(client, {
        fromWalletId: fromWallet.id,
        toWalletId: toWallet.id,
        amount,
        type: 'transfer',
        referencePrefix: 'TRF',
        description,
      });

      if (amount >= 5000) {
        await createComplianceFlagPg(client, {
          userId: fromUserId,
          transactionId: posted.transactionId,
          severity: amount >= 10000 ? 'high' : 'medium',
          reason: `Large wallet transfer (R${amount.toFixed(2)}) to ${toPhone}`,
        });
      }

      await client.query('COMMIT');
      const txnQ = await pool.query<{
        id: string;
        from_wallet_id: string | null;
        to_wallet_id: string | null;
        amount: number;
        type: string;
        status: string;
        reference: string;
        description: string;
        created_at: string;
      }>(`SELECT * FROM transactions WHERE id = $1`, [posted.transactionId]);
      return res.status(201).json({ transaction: toTransaction(txnQ.rows[0]) });
    } catch (e) {
      await client.query('ROLLBACK');
      const err = e as { status?: number; message?: string };
      return res.status(typeof err.status === 'number' ? err.status : 500).json({
        error: err.message ?? 'Transfer failed',
      });
    } finally {
      client.release();
    }
  },
);
