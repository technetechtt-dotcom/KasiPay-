import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import { getPgPool } from '../dbPg.js';
import { toComplianceFlag, toLoan } from '../extraMappers.js';
import {
  formatCents,
  multiplyCentsByRate,
  parseFixedRate,
  parseIntegerCents,
  parseZarToCents,
  type Cents,
} from '../money.js';
import { idempotentPg } from '../middleware/idempotencyPg.js';
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
  amount: z.union([z.string(), z.number()]),
  interestRate: z.union([z.string(), z.number()]),
});

extensionAccountRouterPg.post('/loans', requireAuth, idempotentPg('POST /loans'), async (req, res) => {
  const parsed = loanApplyBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  let amountCents: Cents;
  let rate;
  try {
    amountCents = parseZarToCents(parsed.data.amount);
    rate = parseFixedRate(parsed.data.interestRate);
    const maxRate = parseFixedRate(String(MAX_LOAN_RATE));
    if (rate.units * maxRate.scale > maxRate.units * rate.scale) {
      throw new Error(`Interest rate cannot exceed ${MAX_LOAN_RATE * 100}%`);
    }
  } catch (error) {
    return res.status(400).json({
      error: error instanceof Error ? error.message : 'Invalid loan terms',
    });
  }
  const id = randomUUID();
  const pool = getPgPool();
  await pool.query(
    `INSERT INTO loans (id, user_id, amount_cents, interest_rate, status, repaid_amount_cents)
     VALUES ($1, $2, $3, $4, 'pending', 0)`,
    [id, req.auth!.userId, amountCents.toString(), String(parsed.data.interestRate)],
  );
  const rowQ = await pool.query(`SELECT * FROM loans WHERE id = $1`, [id]);
  return res.status(201).json({ loan: toLoan(rowQ.rows[0]) });
});

type LoanRow = {
  id: string;
  user_id: string;
  amount_cents: string;
  interest_rate: string;
  status: string;
  disbursed_at: string | null;
  due_date: string | null;
  repaid_amount_cents: string;
};

function loanTotalDueCents(row: LoanRow): Cents {
  const principal = parseIntegerCents(row.amount_cents);
  return (principal + multiplyCentsByRate(principal, parseFixedRate(row.interest_rate))) as Cents;
}

extensionAccountRouterPg.patch(
  '/loans/:id/disburse',
  requireAuth,
  idempotentPg('PATCH /loans/:id/disburse'),
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
      const claimed = await client.query(
        `UPDATE loans SET status = 'disbursing'
          WHERE id = $1 AND status = 'pending' RETURNING id`,
        [row.id],
      );
      if (!claimed.rows[0]) {
        throw Object.assign(new Error('Loan was already disbursed'), { status: 409 });
      }
      await postBetweenWalletsPg(client, {
        fromWalletId: escrowId,
        toWalletId: userWallet.id,
        amountCents: parseIntegerCents(row.amount_cents),
        type: 'loan_disbursement',
        referencePrefix: 'LOAN',
        description: `Loan disbursement (${row.interest_rate} rate)`,
      });
      await client.query(
        `UPDATE loans SET status = 'disbursed', disbursed_at = $1 WHERE id = $2`,
        [new Date().toISOString(), row.id],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      const msg = e instanceof Error ? e.message : 'Disbursement failed';
      return res.status((e as { status?: number }).status ?? 500).json({ error: msg });
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
  amount: z.union([z.string(), z.number()]),
});

extensionAccountRouterPg.post(
  '/loans/:id/repayments',
  requireAuth,
  idempotentPg('POST /loans/:id/repayments'),
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
    const totalDueCents = loanTotalDueCents(row);
    const repaidCents = parseIntegerCents(row.repaid_amount_cents, {
      allowZero: true,
    });
    const outstandingCents = (totalDueCents - repaidCents) as Cents;
    if (outstandingCents <= 0n) {
      return res.status(409).json({ error: 'Loan already repaid.' });
    }
    let requestedCents: Cents;
    try {
      requestedCents = parseZarToCents(parsed.data.amount);
    } catch (error) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : 'Invalid amount',
      });
    }
    const repayCents =
      requestedCents < outstandingCents ? requestedCents : outstandingCents;
    const escrowId = await getEscrowWalletIdForPoolPg(pool, DEFAULT_POOL_ID);
    if (!escrowId) {
      return res.status(500).json({ error: 'Escrow wallet not configured' });
    }
    const userWalletQ = await pool.query<{ id: string; balance_cents: string }>(
      `SELECT id, balance_cents FROM wallets WHERE user_id = $1`,
      [row.user_id],
    );
    const userWallet = userWalletQ.rows[0];
    if (!userWallet) {
      return res.status(404).json({ error: 'User wallet missing' });
    }
    if (
      parseIntegerCents(userWallet.balance_cents, { allowZero: true }) <
      repayCents
    ) {
      return res
        .status(402)
        .json({ error: 'Insufficient wallet balance for this repayment.' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<LoanRow>(
        `SELECT * FROM loans WHERE id = $1 FOR UPDATE`,
        [row.id],
      );
      const lockedLoan = locked.rows[0];
      if (
        !lockedLoan ||
        lockedLoan.status !== 'disbursed' ||
        lockedLoan.repaid_amount_cents !== row.repaid_amount_cents
      ) {
        throw Object.assign(new Error('Loan balance changed; retry repayment'), {
          status: 409,
        });
      }
      await postBetweenWalletsPg(client, {
        fromWalletId: userWallet.id,
        toWalletId: escrowId,
        amountCents: repayCents,
        type: 'loan_repayment',
        referencePrefix: 'LOAN-REPAY',
        description: 'Loan repayment',
      });
      const newRepaidCents = (repaidCents + repayCents) as Cents;
      const fullyRepaid = newRepaidCents >= totalDueCents;
      await client.query(
        `UPDATE loans SET repaid_amount_cents = $1, status = $2 WHERE id = $3`,
        [
          newRepaidCents.toString(),
          fullyRepaid ? 'repaid' : 'disbursed',
          row.id,
        ],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      const msg = e instanceof Error ? e.message : 'Repayment failed';
      return res.status((e as { status?: number }).status ?? 500).json({ error: msg });
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
      outstanding: formatCents(
        (loanTotalDueCents(fresh) -
          parseIntegerCents(fresh.repaid_amount_cents, {
            allowZero: true,
          })) as Cents,
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
