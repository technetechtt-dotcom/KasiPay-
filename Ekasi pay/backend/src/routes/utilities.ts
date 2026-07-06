import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import { getDb, getEscrowWalletIdForPool } from '../db.js';
import { toTransaction } from '../mappers.js';
import { idempotent } from '../middleware/idempotency.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { DEFAULT_POOL_ID } from '../poolConstants.js';
import { postBetweenWallets } from '../services/walletPosting.js';
import {
  fulfillUtilityPurchase,
  getUtilityProviderStatus,
} from '../services/utilityProvider.js';

export const utilitiesRouter = Router();

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

function ensureUtilityTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS utility_purchases (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      category TEXT NOT NULL,
      provider TEXT NOT NULL,
      beneficiary TEXT NOT NULL,
      amount REAL NOT NULL,
      reference TEXT NOT NULL,
      voucher_code TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_utility_user_created
      ON utility_purchases(user_id, created_at);
  `);
}

ensureUtilityTable();

utilitiesRouter.get('/utility-purchases/status', requireAuth, (_req, res) => {
  const status = getUtilityProviderStatus();
  return res.json(status);
});

utilitiesRouter.post(
  '/utility-purchases',
  requireAuth,
  idempotent('POST /utility-purchases'),
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

    const database = getDb();
    const userWallet = database
      .prepare(
        `SELECT id, balance, status, pool_id FROM wallets
          WHERE user_id = ? AND COALESCE(wallet_kind, 'user') = 'user'`,
      )
      .get(req.auth!.userId) as
      | { id: string; balance: number; status: string; pool_id?: string }
      | undefined;
    if (!userWallet || userWallet.status !== 'active') {
      return res.status(400).json({ error: 'Wallet unavailable' });
    }
    if (userWallet.balance < parsed.data.amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }
    const poolId = userWallet.pool_id ?? DEFAULT_POOL_ID;
    const escrowId = getEscrowWalletIdForPool(database, poolId);
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
    const descriptionSuffix = fulfillment.mocked ? '(mock voucher)' : '(live vendor)';
    try {
      database.transaction(() => {
        postBetweenWallets(database, {
          fromWalletId: userWallet.id,
          toWalletId: escrowId,
          amount: parsed.data.amount,
          type: 'utility_purchase',
          referencePrefix: 'UTL',
          description: `${parsed.data.category}/${parsed.data.provider} → ${parsed.data.beneficiary} ${descriptionSuffix}`,
        });
        database
          .prepare(
            `INSERT INTO utility_purchases
              (id, user_id, category, provider, beneficiary, amount, reference, voucher_code, status, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?)`,
          )
          .run(
            id,
            req.auth!.userId,
            parsed.data.category,
            parsed.data.provider,
            parsed.data.beneficiary,
            parsed.data.amount,
            reference,
            voucher,
            now,
          );
      })();
    } catch (e) {
      const err = e as { status?: number; message?: string };
      return res.status(typeof err.status === 'number' ? err.status : 500).json({
        error: err.message ?? 'Purchase failed',
      });
    }

    const txnRow = database
      .prepare(
        'SELECT * FROM transactions WHERE reference = ? ORDER BY created_at DESC LIMIT 1',
      )
      .get(reference) as {
      id: string;
      from_wallet_id: string | null;
      to_wallet_id: string | null;
      amount: number;
      type: string;
      status: string;
      reference: string;
      description: string;
      created_at: string;
    };

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
      transaction: toTransaction(txnRow),
      provider: status,
    });
  },
);

utilitiesRouter.get('/utility-purchases', requireAuth, (req, res) => {
  const status = getUtilityProviderStatus();
  const rows = getDb()
    .prepare(
      `SELECT * FROM utility_purchases WHERE user_id = ? ORDER BY datetime(created_at) DESC LIMIT 50`,
    )
    .all(req.auth!.userId) as UtilityRow[];
  return res.json({
    purchases: rows.map((r) => ({
      id: r.id,
      category: r.category,
      provider: r.provider,
      beneficiary: r.beneficiary,
      amount: r.amount,
      reference: r.reference,
      voucherCode: r.voucher_code,
      status: r.status,
      createdAt: r.created_at,
      mocked: status.mocked,
    })),
    provider: status,
  });
});
