import { randomUUID } from 'node:crypto';

import { Router } from 'express';

import { getDb } from '../db.js';
import { idempotent } from '../middleware/idempotency.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { DEFAULT_POOL_ID } from '../poolConstants.js';
import { requireMerchantId } from '../services/merchant.js';
import { saleCreateSchema } from '../validation.js';

type SaleItem = {
  productId: string;
  name: string;
  quantity: number;
  price: number;
  subtotal: number;
  costPrice?: number;
};

function moveWalletFunds(
  database: ReturnType<typeof getDb>,
  fromWalletId: string,
  toWalletId: string,
  amount: number,
  description: string,
  referencePrefix: string
) {
  const from = database.prepare('SELECT * FROM wallets WHERE id = ?').get(fromWalletId) as
    | { id: string; balance: number; status: string; pool_id?: string }
    | undefined;
  const to = database.prepare('SELECT * FROM wallets WHERE id = ?').get(toWalletId) as
    | { id: string; balance: number; status: string; pool_id?: string }
    | undefined;
  if (!from || !to) throw new Error('Wallet missing');
  const fromPool = from.pool_id ?? DEFAULT_POOL_ID;
  const toPool = to.pool_id ?? DEFAULT_POOL_ID;
  if (fromPool !== toPool) {
    throw Object.assign(
      new Error('Customer and shop must be on the same regional wallet pool'),
      { status: 400 }
    );
  }
  if (from.status !== 'active' || to.status !== 'active') {
    throw Object.assign(new Error('Wallet inactive'), { status: 400 });
  }
  if (from.balance < amount) {
    throw Object.assign(new Error('Insufficient balance'), { status: 400 });
  }
  const txnId = randomUUID();
  const now = new Date().toISOString();
  const reference = `${referencePrefix}-${txnId.slice(0, 8).toUpperCase()}`;
  const fromBalanceAfter = from.balance - amount;
  const toBalanceAfter = to.balance + amount;
  const ledgerDebitId = randomUUID();
  const ledgerCreditId = randomUUID();

  database
    .prepare('UPDATE wallets SET balance = ? WHERE id = ?')
    .run(fromBalanceAfter, from.id);
  database
    .prepare('UPDATE wallets SET balance = ? WHERE id = ?')
    .run(toBalanceAfter, to.id);
  database
    .prepare(
      `INSERT INTO transactions (id, from_wallet_id, to_wallet_id, amount, type, status, reference, description, created_at)
       VALUES (?, ?, ?, ?, 'payment', 'completed', ?, ?, ?)`
    )
    .run(
      txnId,
      from.id,
      to.id,
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
    .run(ledgerDebitId, txnId, from.id, amount, fromBalanceAfter, now);
  database
    .prepare(
      `INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount, balance_after, created_at)
       VALUES (?, ?, ?, 'credit', ?, ?, ?)`
    )
    .run(ledgerCreditId, txnId, to.id, amount, toBalanceAfter, now);
}

export const salesRouter = Router();

salesRouter.get('/sales', requireAuth, (req, res) => {
  let merchantId: string;
  try {
    merchantId = requireMerchantId(req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const database = getDb();
  const rows = database
    .prepare(
      'SELECT * FROM sales WHERE merchant_id = ? ORDER BY datetime(created_at) DESC LIMIT 200'
    )
    .all(merchantId) as {
    id: string;
    merchant_id: string;
    items_json: string;
    total: number;
    payment_method: string;
    created_at: string;
  }[];

  const sales = rows.map((row) => ({
    id: row.id,
    merchantId: row.merchant_id,
    items: JSON.parse(row.items_json) as SaleItem[],
    total: row.total,
    paymentMethod: row.payment_method,
    createdAt: row.created_at,
  }));
  return res.json({ sales });
});

salesRouter.post('/sales', requireAuth, idempotent('POST /sales'), (req, res) => {
  const parsed = saleCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  let merchantId: string;
  try {
    merchantId = requireMerchantId(req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const { items, paymentMethod, customerPhone } = parsed.data;
  if (paymentMethod === 'wallet' && !customerPhone) {
    return res
      .status(400)
      .json({ error: 'customerPhone is required for wallet sales' });
  }

  const database = getDb();
  const merchantUser = database
    .prepare('SELECT user_id FROM merchants WHERE id = ?')
    .get(merchantId) as { user_id: string } | undefined;
  if (!merchantUser) {
    return res.status(400).json({ error: 'Merchant not found' });
  }
  const merchantWallet = database
    .prepare(
      `SELECT * FROM wallets WHERE user_id = ? AND COALESCE(wallet_kind, 'user') = 'user'`
    )
    .get(merchantUser.user_id) as
    | { id: string; balance: number; status: string; pool_id?: string }
    | undefined;
  if (!merchantWallet) {
    return res.status(400).json({ error: 'Merchant wallet missing' });
  }

  const saleItems: SaleItem[] = [];
  let computedTotal = 0;

  const saleId = randomUUID();
  const createdAt = new Date().toISOString();

  try {
    database.transaction(() => {
      for (const line of items) {
        const product = database.prepare('SELECT * FROM products WHERE id = ?').get(line.productId) as
          | {
              id: string;
              merchant_id: string;
              name: string;
              stock: number;
              cost_price: number;
            }
          | undefined;
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
        const costAtSale = product.cost_price;
        const subtotal = line.quantity * line.price;
        computedTotal += subtotal;
        saleItems.push({
          productId: product.id,
          name: product.name,
          quantity: line.quantity,
          price: line.price,
          subtotal,
          costPrice: costAtSale,
        });

        database
          .prepare('UPDATE products SET stock = stock - ? WHERE id = ?')
          .run(line.quantity, product.id);

        const movementId = randomUUID();
        database
          .prepare(
            `INSERT INTO stock_movements
              (id, merchant_id, product_id, product_name, type, quantity, reason, cost_price_at_time, reference, notes, created_at)
             VALUES (?, ?, ?, ?, 'out', ?, 'sale', ?, ?, NULL, ?)`,
          )
          .run(
            movementId,
            merchantId,
            product.id,
            product.name,
            line.quantity,
            costAtSale,
            saleId,
            createdAt,
          );
      }

      if (paymentMethod === 'wallet') {
        const customer = database
          .prepare(
            `SELECT id FROM users WHERE phone = ? AND COALESCE(is_system, 0) = 0`
          )
          .get(customerPhone!) as { id: string } | undefined;
        if (!customer) {
          throw Object.assign(new Error('Customer phone not registered'), {
            status: 404,
          });
        }
        const customerWallet = database
          .prepare(
            `SELECT * FROM wallets WHERE user_id = ? AND COALESCE(wallet_kind, 'user') = 'user'`
          )
          .get(customer.id) as
          | { id: string; balance: number; status: string; pool_id?: string }
          | undefined;
        if (!customerWallet) {
          throw Object.assign(new Error('Customer wallet missing'), {
            status: 400,
          });
        }
        moveWalletFunds(
          database,
          customerWallet.id,
          merchantWallet.id,
          computedTotal,
          `Sale ${saleId}`,
          'PAY'
        );
      }

      database
        .prepare(
          `INSERT INTO sales (id, merchant_id, items_json, total, payment_method, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          saleId,
          merchantId,
          JSON.stringify(saleItems),
          computedTotal,
          paymentMethod,
          createdAt
        );
    })();
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string };
    const status = typeof err.status === 'number' ? err.status : 500;
    const message = err.message ?? 'Sale failed';
    if (status >= 500) throw e;
    return res.status(status).json({ error: message });
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
