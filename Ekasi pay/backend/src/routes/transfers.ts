import { randomUUID } from 'node:crypto';

import { Router } from 'express';

import { getDb } from '../db.js';
import { toTransaction } from '../mappers.js';
import { idempotent } from '../middleware/idempotency.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireApprovedMerchant } from '../middleware/requireApprovedMerchant.js';
import { DEFAULT_POOL_ID } from '../poolConstants.js';
import { createComplianceFlag } from '../services/compliance.js';
import { transferBodySchema } from '../validation.js';

export const transfersRouter = Router();

transfersRouter.post(
  '/transfers',
  requireAuth,
  requireApprovedMerchant,
  idempotent('POST /transfers'),
  (req, res) => {
  const parsed = transferBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { toPhone, amount, description } = parsed.data;
  const database = getDb();
  const fromUserId = req.auth!.userId;

  if (toPhone === req.auth!.phone) {
    return res.status(400).json({ error: 'Cannot transfer to the same phone' });
  }

  const fromWallet = database
    .prepare(
      `SELECT * FROM wallets WHERE user_id = ? AND COALESCE(wallet_kind, 'user') = 'user'`
    )
    .get(fromUserId) as
    | {
        id: string;
        balance: number;
        status: string;
        pool_id?: string;
      }
    | undefined;
  if (!fromWallet) {
    return res.status(404).json({ error: 'Wallet not found' });
  }
  if (fromWallet.status !== 'active') {
    return res.status(400).json({ error: 'Wallet is not active' });
  }

  const toUser = database
    .prepare(
      `SELECT id FROM users WHERE phone = ? AND COALESCE(is_system, 0) = 0`
    )
    .get(toPhone) as { id: string } | undefined;
  if (!toUser) {
    return res.status(404).json({ error: 'Recipient not found' });
  }

  const toWallet = database
    .prepare(
      `SELECT * FROM wallets WHERE user_id = ? AND COALESCE(wallet_kind, 'user') = 'user'`
    )
    .get(toUser.id) as
    | {
        id: string;
        balance: number;
        status: string;
        pool_id?: string;
      }
    | undefined;
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
      error: 'Cross-country transfers are not supported yet — recipient must use the same region as you.',
    });
  }

  if (fromWallet.balance < amount) {
    return res.status(400).json({ error: 'Insufficient balance' });
  }

  const txnId = randomUUID();
  const now = new Date().toISOString();
  const reference = `TRF-${txnId.slice(0, 8).toUpperCase()}`;

  const fromBalanceAfter = fromWallet.balance - amount;
  const toBalanceAfter = toWallet.balance + amount;

  const ledgerDebitId = randomUUID();
  const ledgerCreditId = randomUUID();

  database.transaction(() => {
    database
      .prepare('UPDATE wallets SET balance = ? WHERE id = ?')
      .run(fromBalanceAfter, fromWallet.id);
    database
      .prepare('UPDATE wallets SET balance = ? WHERE id = ?')
      .run(toBalanceAfter, toWallet.id);

    database
      .prepare(
        `INSERT INTO transactions (id, from_wallet_id, to_wallet_id, amount, type, status, reference, description, created_at)
         VALUES (?, ?, ?, ?, 'transfer', 'completed', ?, ?, ?)`
      )
      .run(
        txnId,
        fromWallet.id,
        toWallet.id,
        amount,
        reference,
        description,
        now
      );

    database
      .prepare(
        `INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount, balance_after, created_at)
         VALUES (?, ?, ?, 'debit', ?, ?, ?)`
      )
      .run(ledgerDebitId, txnId, fromWallet.id, amount, fromBalanceAfter, now);

    database
      .prepare(
        `INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount, balance_after, created_at)
         VALUES (?, ?, ?, 'credit', ?, ?, ?)`
      )
      .run(ledgerCreditId, txnId, toWallet.id, amount, toBalanceAfter, now);

    if (amount >= 5000) {
      createComplianceFlag(database, {
        userId: fromUserId,
        transactionId: txnId,
        severity: amount >= 10000 ? 'high' : 'medium',
        reason: `Large wallet transfer (R${amount.toFixed(2)}) to ${toPhone}`,
      });
    }
  })();

  const txn = database
    .prepare('SELECT * FROM transactions WHERE id = ?')
    .get(txnId) as {
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

  return res.status(201).json({ transaction: toTransaction(txn) });
  },
);
