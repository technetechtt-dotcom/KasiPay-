import { randomUUID } from 'node:crypto';

import { Router } from 'express';

import { getPgPool } from '../dbPg.js';
import { toCreditCustomer, toCreditTransaction } from '../mappers.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireMerchantIdPg } from '../services/merchantPg.js';
import { creditCustomerCreateSchema, creditTxnSchema } from '../validation.js';

export const creditRouterPg = Router();

creditRouterPg.get('/credit/customers', requireAuth, async (req, res) => {
  const pool = getPgPool();
  let merchantId: string;
  try {
    merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const q = typeof req.query.merchantId === 'string' ? req.query.merchantId : '';
  if (q && q !== merchantId) {
    return res.status(403).json({ error: 'Cannot read another merchant customers' });
  }

  const rows = await pool.query<{
    id: string;
    merchant_id: string;
    name: string;
    phone: string;
    total_owed: number;
    credit_limit: number;
    last_payment_date: string | null;
    created_at: string;
  }>(
    `SELECT * FROM credit_customers WHERE merchant_id = $1 ORDER BY lower(name)`,
    [merchantId],
  );
  return res.json({ customers: rows.rows.map(toCreditCustomer) });
});

creditRouterPg.get('/credit/transactions', requireAuth, async (req, res) => {
  const pool = getPgPool();
  let merchantId: string;
  try {
    merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const rows = await pool.query<{
    id: string;
    customer_id: string;
    type: string;
    amount: number;
    description: string;
    created_at: string;
  }>(
    `SELECT ct.*
       FROM credit_transactions ct
       INNER JOIN credit_customers cc ON cc.id = ct.customer_id
      WHERE cc.merchant_id = $1
      ORDER BY ct.created_at DESC
      LIMIT 500`,
    [merchantId],
  );
  return res.json({ transactions: rows.rows.map(toCreditTransaction) });
});

creditRouterPg.post('/credit/customers', requireAuth, async (req, res) => {
  const parsed = creditCustomerCreateSchema.safeParse(req.body);
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
  const c = parsed.data;
  await pool.query(
    `INSERT INTO credit_customers (id, merchant_id, name, phone, total_owed, credit_limit, created_at)
     VALUES ($1, $2, $3, $4, 0, $5, $6)`,
    [id, merchantId, c.name, c.phone, c.creditLimit, now],
  );
  const row = await pool.query<{
    id: string;
    merchant_id: string;
    name: string;
    phone: string;
    total_owed: number;
    credit_limit: number;
    last_payment_date: string | null;
    created_at: string;
  }>(`SELECT * FROM credit_customers WHERE id = $1`, [id]);
  return res.status(201).json({ customer: toCreditCustomer(row.rows[0]) });
});

creditRouterPg.post('/credit/transactions', requireAuth, async (req, res) => {
  const parsed = creditTxnSchema.safeParse(req.body);
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

  const { customerId, type, amount, description } = parsed.data;
  const customerQ = await pool.query<{
    id: string;
    merchant_id: string;
    total_owed: number;
    credit_limit: number;
  }>(`SELECT * FROM credit_customers WHERE id = $1`, [customerId]);
  const customer = customerQ.rows[0];
  if (!customer || customer.merchant_id !== merchantId) {
    return res.status(404).json({ error: 'Customer not found' });
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  let nextTotal = customer.total_owed;
  if (type === 'purchase') {
    nextTotal += amount;
    if (nextTotal > customer.credit_limit) {
      return res.status(400).json({ error: 'Would exceed credit limit' });
    }
  } else {
    nextTotal = Math.max(0, customer.total_owed - amount);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO credit_transactions (id, customer_id, type, amount, description, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, customerId, type, amount, description, now],
    );
    if (type === 'payment') {
      await client.query(
        `UPDATE credit_customers SET total_owed = $1, last_payment_date = $2 WHERE id = $3`,
        [nextTotal, now, customerId],
      );
    } else {
      await client.query(
        `UPDATE credit_customers SET total_owed = $1 WHERE id = $2`,
        [nextTotal, customerId],
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  const updated = await pool.query<{
    id: string;
    merchant_id: string;
    name: string;
    phone: string;
    total_owed: number;
    credit_limit: number;
    last_payment_date: string | null;
    created_at: string;
  }>(`SELECT * FROM credit_customers WHERE id = $1`, [customerId]);
  const txnRow = await pool.query<{
    id: string;
    customer_id: string;
    type: string;
    amount: number;
    description: string;
    created_at: string;
  }>(`SELECT * FROM credit_transactions WHERE id = $1`, [id]);
  return res.status(201).json({
    transaction: toCreditTransaction(txnRow.rows[0]),
    customer: toCreditCustomer(updated.rows[0]),
  });
});
