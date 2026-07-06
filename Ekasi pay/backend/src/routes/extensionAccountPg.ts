import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import { getPgPool } from '../dbPg.js';
import { toComplianceFlag, toLoan } from '../extraMappers.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { DEFAULT_POOL_ID } from '../poolConstants.js';
import { getEscrowWalletIdForPoolPg } from '../services/escrowPg.js';
import { postBetweenWalletsPg } from '../services/walletPostingPg.js';

export const extensionAccountRouterPg = Router();

const MAX_LOAN_RATE = 1.5;

extensionAccountRouterPg.get('/loans/me', requireAuth, async (req, res) => {
  const pool = getPgPool();
  const r = await pool.query(
    `SELECT * FROM loans WHERE user_id = $1 ORDER BY id DESC`,
    [req.auth!.userId],
  );
  return res.json({ loans: r.rows.map(toLoan) });
});

const loanApplyBody = z.object({
  amount: z.coerce.number().positive(),
  interestRate: z.coerce
    .number()
    .nonnegative()
    .max(MAX_LOAN_RATE, `Interest rate cannot exceed ${MAX_LOAN_RATE * 100}%`),
});

extensionAccountRouterPg.post('/loans', requireAuth, async (req, res) => {
  const parsed = loanApplyBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const id = randomUUID();
  const pool = getPgPool();
  await pool.query(
    `INSERT INTO loans (id, user_id, amount, interest_rate, status, repaid_amount)
     VALUES ($1, $2, $3, $4, 'pending', 0)`,
    [id, req.auth!.userId, parsed.data.amount, parsed.data.interestRate],
  );
  const rowQ = await pool.query(`SELECT * FROM loans WHERE id = $1`, [id]);
  return res.status(201).json({ loan: toLoan(rowQ.rows[0]) });
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

function loanTotalDue(row: LoanRow): number {
  return Number((row.amount * (1 + row.interest_rate)).toFixed(2));
}

extensionAccountRouterPg.patch(
  '/loans/:id/disburse',
  requireAuth,
  async (req, res) => {
    if (req.auth!.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    const pool = getPgPool();
    const rowQ = await pool.query<LoanRow>(
      `SELECT * FROM loans WHERE id = $1`,
      [req.params.id],
    );
    const row = rowQ.rows[0];
    if (!row) return res.status(404).json({ error: 'Loan not found' });
    if (row.status !== 'pending') {
      return res
        .status(409)
        .json({ error: `Loan is already ${row.status}` });
    }
    const escrowId = await getEscrowWalletIdForPoolPg(pool, DEFAULT_POOL_ID);
    if (!escrowId) {
      return res.status(500).json({ error: 'Escrow wallet not configured' });
    }
    const userWalletQ = await pool.query<{ id: string }>(
      `SELECT id FROM wallets WHERE user_id = $1`,
      [row.user_id],
    );
    const userWallet = userWalletQ.rows[0];
    if (!userWallet) {
      return res.status(404).json({ error: 'User wallet missing' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await postBetweenWalletsPg(client, {
        fromWalletId: escrowId,
        toWalletId: userWallet.id,
        amount: row.amount,
        type: 'loan_disbursement',
        referencePrefix: 'LOAN',
        description: `Loan disbursement (${(row.interest_rate * 100).toFixed(1)}% rate)`,
      });
      await client.query(
        `UPDATE loans SET status = 'disbursed', disbursed_at = $1 WHERE id = $2`,
        [new Date().toISOString(), row.id],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      const msg = e instanceof Error ? e.message : 'Disbursement failed';
      return res.status(500).json({ error: msg });
    } finally {
      client.release();
    }
    const freshQ = await pool.query<LoanRow>(
      `SELECT * FROM loans WHERE id = $1`,
      [row.id],
    );
    return res.json({ loan: toLoan(freshQ.rows[0]) });
  },
);

const loanRepayBody = z.object({
  amount: z.coerce.number().positive(),
});

extensionAccountRouterPg.post(
  '/loans/:id/repayments',
  requireAuth,
  async (req, res) => {
    const parsed = loanRepayBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const pool = getPgPool();
    const rowQ = await pool.query<LoanRow>(
      `SELECT * FROM loans WHERE id = $1`,
      [req.params.id],
    );
    const row = rowQ.rows[0];
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
    const escrowId = await getEscrowWalletIdForPoolPg(pool, DEFAULT_POOL_ID);
    if (!escrowId) {
      return res.status(500).json({ error: 'Escrow wallet not configured' });
    }
    const userWalletQ = await pool.query<{ id: string; balance: number }>(
      `SELECT id, balance FROM wallets WHERE user_id = $1`,
      [row.user_id],
    );
    const userWallet = userWalletQ.rows[0];
    if (!userWallet) {
      return res.status(404).json({ error: 'User wallet missing' });
    }
    if (userWallet.balance < repayAmount) {
      return res
        .status(402)
        .json({ error: 'Insufficient wallet balance for this repayment.' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await postBetweenWalletsPg(client, {
        fromWalletId: userWallet.id,
        toWalletId: escrowId,
        amount: repayAmount,
        type: 'loan_repayment',
        referencePrefix: 'LOAN-REPAY',
        description: 'Loan repayment',
      });
      const newRepaid = Number((row.repaid_amount + repayAmount).toFixed(2));
      const fullyRepaid = newRepaid >= totalDue - 0.005;
      await client.query(
        `UPDATE loans SET repaid_amount = $1, status = $2 WHERE id = $3`,
        [newRepaid, fullyRepaid ? 'repaid' : 'disbursed', row.id],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      const msg = e instanceof Error ? e.message : 'Repayment failed';
      return res.status(500).json({ error: msg });
    } finally {
      client.release();
    }
    const freshQ = await pool.query<LoanRow>(
      `SELECT * FROM loans WHERE id = $1`,
      [row.id],
    );
    const fresh = freshQ.rows[0];
    return res.json({
      loan: toLoan(fresh),
      outstanding: Number(
        (loanTotalDue(fresh) - fresh.repaid_amount).toFixed(2),
      ),
    });
  },
);

extensionAccountRouterPg.get(
  '/compliance/me',
  requireAuth,
  async (req, res) => {
    const pool = getPgPool();
    const r = await pool.query(
      `SELECT * FROM compliance_flags
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.auth!.userId],
    );
    return res.json({ flags: r.rows.map(toComplianceFlag) });
  },
);
