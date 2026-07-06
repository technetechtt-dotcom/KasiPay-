import { randomUUID } from 'node:crypto';

import { Router } from 'express';

import { getPgPool } from '../dbPg.js';
import { idempotentPg } from '../middleware/idempotencyPg.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireMerchantIdPg } from '../services/merchantPg.js';
import { postBetweenWalletsPg } from '../services/walletPostingPg.js';
import { saleCreateSchema } from '../validation.js';

type SaleItem = {
  productId: string;
  name: string;
  quantity: number;
  price: number;
  subtotal: number;
};

export const salesRouterPg = Router();

salesRouterPg.get('/sales', requireAuth, async (req, res) => {
  const pool = getPgPool();
  let merchantId: string;
  try {
    merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }

  const rows = await pool.query<{
    id: string;
    merchant_id: string;
    items_json: string;
    total: number;
    payment_method: string;
    created_at: string;
  }>(
    `SELECT * FROM sales WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [merchantId],
  );

  const sales = rows.rows.map((row) => ({
    id: row.id,
    merchantId: row.merchant_id,
    items: JSON.parse(row.items_json) as SaleItem[],
    total: row.total,
    paymentMethod: row.payment_method,
    createdAt: row.created_at,
  }));
  return res.json({ sales });
});

salesRouterPg.post('/sales', requireAuth, idempotentPg('POST /sales'), async (req, res) => {
  const parsed = saleCreateSchema.safeParse(req.body);
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

  const { items, paymentMethod, customerPhone } = parsed.data;
  if (paymentMethod === 'wallet' && !customerPhone) {
    return res
      .status(400)
      .json({ error: 'customerPhone is required for wallet sales' });
  }

  const merchantUserQ = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM merchants WHERE id = $1`,
    [merchantId],
  );
  const merchantUser = merchantUserQ.rows[0];
  if (!merchantUser) return res.status(400).json({ error: 'Merchant not found' });

  const merchantWalletQ = await pool.query<{
    id: string;
    balance: number;
    status: string;
    pool_id: string | null;
  }>(
    `SELECT * FROM wallets WHERE user_id = $1 AND COALESCE(wallet_kind, 'user') = 'user'`,
    [merchantUser.user_id],
  );
  const merchantWallet = merchantWalletQ.rows[0];
  if (!merchantWallet) {
    return res.status(400).json({ error: 'Merchant wallet missing' });
  }

  const saleItems: SaleItem[] = [];
  let computedTotal = 0;
  const saleId = randomUUID();
  const createdAt = new Date().toISOString();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const line of items) {
      const productQ = await client.query<{
        id: string;
        merchant_id: string;
        name: string;
        stock: number;
      }>(`SELECT id, merchant_id, name, stock FROM products WHERE id = $1`, [
        line.productId,
      ]);
      const product = productQ.rows[0];
      if (!product) {
        throw Object.assign(new Error('Product not found'), { status: 404 });
      }
      if (product.merchant_id !== merchantId) {
        throw Object.assign(new Error('Product not in your store'), {
          status: 403,
        });
      }
      if (product.stock < line.quantity) {
        throw Object.assign(new Error(`Insufficient stock for ${product.name}`), {
          status: 400,
        });
      }

      const subtotal = line.quantity * line.price;
      computedTotal += subtotal;
      saleItems.push({
        productId: product.id,
        name: product.name,
        quantity: line.quantity,
        price: line.price,
        subtotal,
      });

      await client.query(`UPDATE products SET stock = stock - $1 WHERE id = $2`, [
        line.quantity,
        product.id,
      ]);
    }

    if (paymentMethod === 'wallet') {
      const customerQ = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE phone = $1 AND COALESCE(is_system, 0) = 0`,
        [customerPhone!],
      );
      const customer = customerQ.rows[0];
      if (!customer) {
        throw Object.assign(new Error('Customer phone not registered'), {
          status: 404,
        });
      }

      const customerWalletQ = await client.query<{
        id: string;
        balance: number;
        status: string;
        pool_id: string | null;
      }>(
        `SELECT * FROM wallets WHERE user_id = $1 AND COALESCE(wallet_kind, 'user') = 'user'`,
        [customer.id],
      );
      const customerWallet = customerWalletQ.rows[0];
      if (!customerWallet) {
        throw Object.assign(new Error('Customer wallet missing'), { status: 400 });
      }

      await postBetweenWalletsPg(client, {
        fromWalletId: customerWallet.id,
        toWalletId: merchantWallet.id,
        amount: computedTotal,
        type: 'payment',
        referencePrefix: 'PAY',
        description: `Sale ${saleId}`,
      });
    }

    await client.query(
      `INSERT INTO sales (id, merchant_id, items_json, total, payment_method, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        saleId,
        merchantId,
        JSON.stringify(saleItems),
        computedTotal,
        paymentMethod,
        createdAt,
      ],
    );

    await client.query('COMMIT');
  } catch (e: unknown) {
    await client.query('ROLLBACK');
    const err = e as { status?: number; message?: string };
    const status = typeof err.status === 'number' ? err.status : 500;
    const message = err.message ?? 'Sale failed';
    if (status >= 500) throw e;
    return res.status(status).json({ error: message });
  } finally {
    client.release();
  }

  return res.status(201).json({
    sale: {
      id: saleId,
      merchantId,
      items: saleItems,
      total: computedTotal,
      paymentMethod,
      createdAt,
    },
  });
});
