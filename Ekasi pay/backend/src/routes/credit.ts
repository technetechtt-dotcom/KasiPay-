import { randomUUID } from 'node:crypto';

import { Router } from 'express';

import { getDb } from '../db.js';
import { toCreditCustomer, toCreditTransaction } from '../mappers.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireMerchantId } from '../services/merchant.js';
import { creditCustomerCreateSchema, creditTxnSchema } from '../validation.js';

export const creditRouter = Router();

creditRouter.get('/credit/customers', requireAuth, (req, res) => {
  let merchantId: string;
  try {
    merchantId = requireMerchantId(req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const q = typeof req.query.merchantId === 'string' ? req.query.merchantId : '';
  if (q && q !== merchantId) {
    return res.status(403).json({ error: 'Cannot read another merchant customers' });
  }
  const database = getDb();
  const rows = database
    .prepare(
      'SELECT * FROM credit_customers WHERE merchant_id = ? ORDER BY name COLLATE NOCASE'
    )
    .all(merchantId) as {
    id: string;
    merchant_id: string;
    name: string;
    phone: string;
    total_owed: number;
    credit_limit: number;
    last_payment_date: string | null;
    created_at: string;
  }[];
  return res.json({ customers: rows.map(toCreditCustomer) });
});

creditRouter.get('/credit/transactions', requireAuth, (req, res) => {
  let merchantId: string;
  try {
    merchantId = requireMerchantId(req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const database = getDb();
  const rows = database
    .prepare(
      `SELECT ct.* FROM credit_transactions ct
       INNER JOIN credit_customers cc ON cc.id = ct.customer_id
       WHERE cc.merchant_id = ?
       ORDER BY datetime(ct.created_at) DESC
       LIMIT 500`
    )
    .all(merchantId) as {
    id: string;
    customer_id: string;
    type: string;
    amount: number;
    description: string;
    created_at: string;
  }[];
  return res.json({ transactions: rows.map(toCreditTransaction) });
});

creditRouter.post('/credit/customers', requireAuth, (req, res) => {
  const parsed = creditCustomerCreateSchema.safeParse(req.body);
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
  const c = parsed.data;
  database
    .prepare(
      `INSERT INTO credit_customers (id, merchant_id, name, phone, total_owed, credit_limit, created_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`
    )
    .run(id, merchantId, c.name, c.phone, c.creditLimit, now);
  const row = database.prepare('SELECT * FROM credit_customers WHERE id = ?').get(id) as {
    id: string;
    merchant_id: string;
    name: string;
    phone: string;
    total_owed: number;
    credit_limit: number;
    last_payment_date: string | null;
    created_at: string;
  };
  return res.status(201).json({ customer: toCreditCustomer(row) });
});

creditRouter.post('/credit/transactions', requireAuth, (req, res) => {
  const parsed = creditTxnSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  let merchantId: string;
  try {
    merchantId = requireMerchantId(req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }

  const { customerId, type, amount, description } = parsed.data;
  const database = getDb();
  const customer = database
    .prepare('SELECT * FROM credit_customers WHERE id = ?')
    .get(customerId) as
    | {
        id: string;
        merchant_id: string;
        total_owed: number;
        credit_limit: number;
      }
    | undefined;
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

  database.transaction(() => {
    database
      .prepare(
        `INSERT INTO credit_transactions (id, customer_id, type, amount, description, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, customerId, type, amount, description, now);
    if (type === 'payment') {
      database
        .prepare(
          `UPDATE credit_customers SET total_owed = ?, last_payment_date = ? WHERE id = ?`
        )
        .run(nextTotal, now, customerId);
    } else {
      database
        .prepare(`UPDATE credit_customers SET total_owed = ? WHERE id = ?`)
        .run(nextTotal, customerId);
    }
  })();

  // Re-fetch customer for consistency (last_payment_date)
  const updated = database.prepare('SELECT * FROM credit_customers WHERE id = ?').get(customerId) as {
    id: string;
    merchant_id: string;
    name: string;
    phone: string;
    total_owed: number;
    credit_limit: number;
    last_payment_date: string | null;
    created_at: string;
  };

  const txnRow = database.prepare('SELECT * FROM credit_transactions WHERE id = ?').get(id) as {
    id: string;
    customer_id: string;
    type: string;
    amount: number;
    description: string;
    created_at: string;
  };

  return res.status(201).json({
    transaction: toCreditTransaction(txnRow),
    customer: toCreditCustomer(updated),
  });
});
