import { randomUUID } from 'node:crypto';

import { Router } from 'express';

import { getDb } from '../db.js';
import { toExpense } from '../mappers.js';
import { idempotent } from '../middleware/idempotency.js';
import { requireApprovedMerchant } from '../middleware/requireApprovedMerchant.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireMerchantId } from '../services/merchant.js';
import { expenseCreateSchema } from '../validation.js';

export const expensesRouter = Router();
expensesRouter.use(requireAuth, requireApprovedMerchant);

expensesRouter.get('/expenses', requireAuth, (req, res) => {
  let merchantId: string;
  try {
    merchantId = requireMerchantId(req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const q = typeof req.query.merchantId === 'string' ? req.query.merchantId : '';
  if (q && q !== merchantId) {
    return res.status(403).json({ error: 'Cannot read another merchant expenses' });
  }
  const database = getDb();
  const rows = database
    .prepare(
      'SELECT * FROM expenses WHERE merchant_id = ? ORDER BY datetime(created_at) DESC LIMIT 500'
    )
    .all(merchantId) as {
    id: string;
    merchant_id: string;
    category: string;
    description: string;
    amount: number;
    created_at: string;
  }[];
  return res.json({ expenses: rows.map(toExpense) });
});

expensesRouter.post(
  '/expenses',
  requireAuth,
  idempotent('POST /expenses'),
  (req, res) => {
  const parsed = expenseCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  let merchantId: string;
  try {
    merchantId = requireMerchantId(req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const database = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  const e = parsed.data;
  database
    .prepare(
      `INSERT INTO expenses (id, merchant_id, category, description, amount, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(id, merchantId, e.category, e.description, e.amount, now);
  const row = database.prepare('SELECT * FROM expenses WHERE id = ?').get(id) as {
    id: string;
    merchant_id: string;
    category: string;
    description: string;
    amount: number;
    created_at: string;
  };
  return res.status(201).json({ expense: toExpense(row) });
  },
);
