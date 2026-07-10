import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import { getPgPool } from '../dbPg.js';
import { toTransaction } from '../mappers.js';
import { idempotentPg } from '../middleware/idempotencyPg.js';
import { requireApprovedMerchant } from '../middleware/requireApprovedMerchant.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { DEFAULT_POOL_ID } from '../poolConstants.js';
import { getEscrowWalletIdForPoolPg } from '../services/escrowPg.js';
import {
  fulfillUtilityPurchase,
  getUtilityProviderStatus,
} from '../services/utilityProvider.js';
import { postBetweenWalletsPg } from '../services/walletPostingPg.js';

export const utilitiesRouterPg = Router();

utilitiesRouterPg.use(requireAuth, requireApprovedMerchant);

const buyBody = z.object({
  category: z.enum(['airtime', 'data', 'electricity', 'dstv']),
  provider: z.string().min(2).max(64),
  beneficiary: z.string().min(3).max(64),
  amount: z.coerce.number().positive(),
});

type UtilityRow = {
  id: string;
  user_id: string;
  category: string;
  provider: string;
  beneficiary: string;
  amount: number;
  reference: string;
  voucher_code: string | null;
  status: string;
  created_at: string;
};

utilitiesRouterPg.get(
  '/utility-purchases/status',
  requireAuth,
  (_req, res) => {
    const status = getUtilityProviderStatus();
    return res.json(status);
  },
);

utilitiesRouterPg.post(
  '/utility-purchases',
  requireAuth,
  idempotentPg('POST /utility-purchases'),
  async (req, res) => {
    const parsed = buyBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const providerStatus = getUtilityProviderStatus();
    if (!providerStatus.available) {
      return res.status(503).json({
        error: 'Utility purchases are not available on this deployment.',
      });
    }
    if (parsed.data.amount > providerStatus.maxAmount) {
      return res.status(400).json({
        error: `Amount exceeds maximum of R${providerStatus.maxAmount}`,
      });
    }

    const pool = getPgPool();
    const userWalletQ = await pool.query<{
      id: string;
      balance: number;
      status: string;
      pool_id: string | null;
    }>(
      `SELECT id, balance, status, pool_id FROM wallets
        WHERE user_id = $1 AND COALESCE(wallet_kind, 'user') = 'user'`,
      [req.auth!.userId],
    );
    const userWallet = userWalletQ.rows[0];
    if (!userWallet || userWallet.status !== 'active') {
      return res.status(400).json({ error: 'Wallet unavailable' });
    }
    if (userWallet.balance < parsed.data.amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }
    const poolId = userWallet.pool_id ?? DEFAULT_POOL_ID;
    const escrowId = await getEscrowWalletIdForPoolPg(pool, poolId);
    if (!escrowId) {
      return res.status(503).json({ error: 'Regional float is unavailable' });
    }

    const id = randomUUID();
    const reference = `UTL-${id.slice(0, 8).toUpperCase()}`;
    const now = new Date().toISOString();

    let fulfillment;
    try {
      fulfillment = await fulfillUtilityPurchase({
        category: parsed.data.category,
        provider: parsed.data.provider,
        beneficiary: parsed.data.beneficiary,
        amount: parsed.data.amount,
        reference,
        userId: req.auth!.userId,
      });
    } catch (e) {
      const err = e as { status?: number; message?: string };
      return res.status(typeof err.status === 'number' ? err.status : 500).json({
        error: err.message ?? 'Purchase failed',
      });
    }

    const voucher = fulfillment.voucherCode;
    const descriptionSuffix = fulfillment.mocked
      ? '(mock voucher)'
      : '(live vendor)';
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await postBetweenWalletsPg(client, {
        fromWalletId: userWallet.id,
        toWalletId: escrowId,
        amount: parsed.data.amount,
        type: 'utility_purchase',
        referencePrefix: 'UTL',
        description: `${parsed.data.category}/${parsed.data.provider} → ${parsed.data.beneficiary} ${descriptionSuffix}`,
      });
      await client.query(
        `INSERT INTO utility_purchases
          (id, user_id, category, provider, beneficiary, amount, reference, voucher_code, status, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'completed', $9)`,
        [
          id,
          req.auth!.userId,
          parsed.data.category,
          parsed.data.provider,
          parsed.data.beneficiary,
          parsed.data.amount,
          reference,
          voucher,
          now,
        ],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      const err = e as { status?: number; message?: string };
      return res.status(typeof err.status === 'number' ? err.status : 500).json({
        error: err.message ?? 'Purchase failed',
      });
    } finally {
      client.release();
    }

    const txnQ = await pool.query(
      `SELECT * FROM transactions WHERE reference = $1 ORDER BY created_at DESC LIMIT 1`,
      [reference],
    );
    const txnRow = txnQ.rows[0] as {
      id: string;
      from_wallet_id: string | null;
      to_wallet_id: string | null;
      amount: number;
      type: string;
      status: string;
      reference: string;
      description: string;
      created_at: string;
    } | undefined;

    const status = getUtilityProviderStatus();
    return res.status(201).json({
      purchase: {
        id,
        category: parsed.data.category,
        provider: parsed.data.provider,
        beneficiary: parsed.data.beneficiary,
        amount: parsed.data.amount,
        reference,
        voucherCode: voucher,
        status: 'completed' as const,
        createdAt: now,
        mocked: fulfillment.mocked,
        providerReference: fulfillment.providerReference,
      },
      transaction: txnRow ? toTransaction(txnRow) : undefined,
      provider: status,
    });
  },
);

utilitiesRouterPg.get('/utility-purchases', requireAuth, async (req, res) => {
  const status = getUtilityProviderStatus();
  const pool = getPgPool();
  const r = await pool.query<UtilityRow>(
    `SELECT * FROM utility_purchases
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [req.auth!.userId],
  );
  return res.json({
    purchases: r.rows.map((row) => ({
      id: row.id,
      category: row.category,
      provider: row.provider,
      beneficiary: row.beneficiary,
      amount: row.amount,
      reference: row.reference,
      voucherCode: row.voucher_code,
      status: row.status,
      createdAt: row.created_at,
      mocked: status.mocked,
    })),
    provider: status,
  });
});
