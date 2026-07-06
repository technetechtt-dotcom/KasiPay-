import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import { getDb, getEscrowWalletIdForPool } from '../db.js';
import { toComplianceFlag, toLoan } from '../extraMappers.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { DEFAULT_POOL_ID } from '../poolConstants.js';
import { postBetweenWallets } from '../services/walletPosting.js';

export const extensionAccountRouter = Router();

/**
 * Loan interest is a decimal fraction per period (e.g. 0.12 = 12%). We refuse
 * absurdly high rates server-side so a buggy / hostile client can't slip a
 * 1000% APR past validation.
 */
const MAX_LOAN_RATE = 1.5;

extensionAccountRouter.get('/loans/me', requireAuth, (req, res) => {
  const database = getDb();
  const rows = database
    .prepare('SELECT * FROM loans WHERE user_id = ? ORDER BY id DESC')
    .all(req.auth!.userId) as {
    id: string;
    user_id: string;
    amount: number;
    interest_rate: number;
    status: string;
    disbursed_at: string | null;
    due_date: string | null;
    repaid_amount: number;
  }[];
  return res.json({ loans: rows.map(toLoan) });
});

const loanApplyBody = z.object({
  amount: z.coerce.number().positive(),
  /** Decimal fraction (0.12 = 12%). Required so a missing field can never become a 0%/free loan. */
  interestRate: z.coerce
    .number()
    .nonnegative()
    .max(MAX_LOAN_RATE, `Interest rate cannot exceed ${MAX_LOAN_RATE * 100}%`),
});

extensionAccountRouter.post('/loans', requireAuth, (req, res) => {
  const parsed = loanApplyBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const id = randomUUID();
  const database = getDb();
  database
    .prepare(
      `INSERT INTO loans (id, user_id, amount, interest_rate, status, repaid_amount)
       VALUES (?, ?, ?, ?, 'pending', 0)`
    )
    .run(id, req.auth!.userId, parsed.data.amount, parsed.data.interestRate);
  const row = database.prepare('SELECT * FROM loans WHERE id = ?').get(id) as {
    id: string;
    user_id: string;
    amount: number;
    interest_rate: number;
    status: string;
    disbursed_at: string | null;
    due_date: string | null;
    repaid_amount: number;
  };
  return res.status(201).json({ loan: toLoan(row) });
});

type LoanRow = {
  id: string;
  user_id: string;
  amount: number;
  interest_rate: number;
  status: string;
  disbursed_at: string | null;
  due_date: string | null;
  repaid_amount: number;
};

/** Total owed including interest at the agreed rate. */
function loanTotalDue(row: LoanRow): number {
  return Number((row.amount * (1 + row.interest_rate)).toFixed(2));
}

/**
 * Admin disburse: flips a pending loan to `disbursed` and debits the network
 * escrow → user wallet (so the user's balance reflects the cash they got).
 */
extensionAccountRouter.patch(
  '/loans/:id/disburse',
  requireAuth,
  (req, res) => {
    if (req.auth!.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    const database = getDb();
    const row = database
      .prepare('SELECT * FROM loans WHERE id = ?')
      .get(req.params.id) as LoanRow | undefined;
    if (!row) return res.status(404).json({ error: 'Loan not found' });
    if (row.status !== 'pending') {
      return res
        .status(409)
        .json({ error: `Loan is already ${row.status}` });
    }
    const escrowId = getEscrowWalletIdForPool(database, DEFAULT_POOL_ID);
    if (!escrowId) {
      return res.status(500).json({ error: 'Escrow wallet not configured' });
    }
    const userWallet = database
      .prepare('SELECT id FROM wallets WHERE user_id = ?')
      .get(row.user_id) as { id: string } | undefined;
    if (!userWallet) {
      return res.status(404).json({ error: 'User wallet missing' });
    }
    try {
      database.transaction(() => {
        postBetweenWallets(database, {
          fromWalletId: escrowId,
          toWalletId: userWallet.id,
          amount: row.amount,
          type: 'loan_disbursement',
          referencePrefix: 'LOAN',
          description: `Loan disbursement (${(row.interest_rate * 100).toFixed(1)}% rate)`,
        });
        database
          .prepare(
            `UPDATE loans
               SET status = 'disbursed', disbursed_at = ?
             WHERE id = ?`,
          )
          .run(new Date().toISOString(), row.id);
      })();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Disbursement failed';
      return res.status(500).json({ error: msg });
    }
    const fresh = database
      .prepare('SELECT * FROM loans WHERE id = ?')
      .get(row.id) as LoanRow;
    return res.json({ loan: toLoan(fresh) });
  },
);

const loanRepayBody = z.object({
  amount: z.coerce.number().positive(),
});

/** Borrower-side repayment: debits user wallet → escrow, increments `repaid_amount`. */
extensionAccountRouter.post(
  '/loans/:id/repayments',
  requireAuth,
  (req, res) => {
    const parsed = loanRepayBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const database = getDb();
    const row = database
      .prepare('SELECT * FROM loans WHERE id = ?')
      .get(req.params.id) as LoanRow | undefined;
    if (!row) return res.status(404).json({ error: 'Loan not found' });
    if (row.user_id !== req.auth!.userId) {
      return res.status(403).json({ error: 'Not your loan' });
    }
    if (row.status !== 'disbursed') {
      return res
        .status(409)
        .json({ error: `Loan is ${row.status} — nothing to repay.` });
    }
    const totalDue = loanTotalDue(row);
    const outstanding = Number((totalDue - row.repaid_amount).toFixed(2));
    if (outstanding <= 0) {
      return res.status(409).json({ error: 'Loan already repaid.' });
    }
    const repayAmount = Math.min(parsed.data.amount, outstanding);
    const escrowId = getEscrowWalletIdForPool(database, DEFAULT_POOL_ID);
    if (!escrowId) {
      return res.status(500).json({ error: 'Escrow wallet not configured' });
    }
    const userWallet = database
      .prepare('SELECT id, balance FROM wallets WHERE user_id = ?')
      .get(row.user_id) as { id: string; balance: number } | undefined;
    if (!userWallet) {
      return res.status(404).json({ error: 'User wallet missing' });
    }
    if (userWallet.balance < repayAmount) {
      return res
        .status(402)
        .json({ error: 'Insufficient wallet balance for this repayment.' });
    }
    try {
      database.transaction(() => {
        postBetweenWallets(database, {
          fromWalletId: userWallet.id,
          toWalletId: escrowId,
          amount: repayAmount,
          type: 'loan_repayment',
          referencePrefix: 'LOAN-REPAY',
          description: 'Loan repayment',
        });
        const newRepaid = Number((row.repaid_amount + repayAmount).toFixed(2));
        const fullyRepaid = newRepaid >= totalDue - 0.005;
        database
          .prepare(
            `UPDATE loans
               SET repaid_amount = ?, status = ?
             WHERE id = ?`,
          )
          .run(newRepaid, fullyRepaid ? 'repaid' : 'disbursed', row.id);
      })();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Repayment failed';
      return res.status(500).json({ error: msg });
    }
    const fresh = database
      .prepare('SELECT * FROM loans WHERE id = ?')
      .get(row.id) as LoanRow;
    return res.json({ loan: toLoan(fresh), outstanding: Number((loanTotalDue(fresh) - fresh.repaid_amount).toFixed(2)) });
  },
);

extensionAccountRouter.get('/compliance/me', requireAuth, (req, res) => {
  const database = getDb();
  const rows = database
    .prepare(
      'SELECT * FROM compliance_flags WHERE user_id = ? ORDER BY datetime(created_at) DESC'
    )
    .all(req.auth!.userId) as {
    id: string;
    user_id: string;
    transaction_id: string | null;
    reason: string;
    severity: string;
    status: string;
    created_at: string;
  }[];
  return res.json({ flags: rows.map(toComplianceFlag) });
});
