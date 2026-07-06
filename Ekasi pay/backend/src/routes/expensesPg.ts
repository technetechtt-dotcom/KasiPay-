import { randomUUID } from 'node:crypto';

import { Router } from 'express';

import { getPgPool } from '../dbPg.js';
import { toExpense } from '../mappers.js';
import { idempotentPg } from '../middleware/idempotencyPg.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireMerchantIdPg } from '../services/merchantPg.js';
import { expenseCreateSchema } from '../validation.js';

export const expensesRouterPg = Router();

expensesRouterPg.get('/expenses', requireAuth, async (req, res) => {
  const pool = getPgPool();
  let merchantId: string;
  try {
    merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const q = typeof req.query.merchantId === 'string' ? req.query.merchantId : '';
  if (q && q !== merchantId) {
    return res.status(403).json({ error: 'Cannot read another merchant expenses' });
  }
  const rows = await pool.query<{
    id: string;
    merchant_id: string;
    category: string;
    description: string;
    amount: number;
    created_at: string;
  }>(
    `SELECT * FROM expenses WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 500`,
    [merchantId],
  );
  return res.json({ expenses: rows.rows.map(toExpense) });
});

expensesRouterPg.post('/expenses', requireAuth, idempotentPg('POST /expenses'), async (req, res) => {
  const parsed = expenseCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const pool = getPgPool();
  let merchantId: string;
  try {
    merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  const e = parsed.data;
  await pool.query(
    `INSERT INTO expenses (id, merchant_id, category, description, amount, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, merchantId, e.category, e.description, e.amount, now],
  );
  const row = await pool.query<{
    id: string;
    merchant_id: string;
    category: string;
    description: string;
    amount: number;
    created_at: string;
  }>(`SELECT * FROM expenses WHERE id = $1`, [id]);
  return res.status(201).json({ expense: toExpense(row.rows[0]) });
});
