import { randomUUID } from 'node:crypto';

import { Router } from 'express';

import { getPgPool } from '../dbPg.js';
import {
  formatCents,
  multiplyCentsByQuantity,
  parseIntegerCents,
  parseZarToCents,
  type Cents,
} from '../money.js';
import { idempotentPg } from '../middleware/idempotencyPg.js';
import { requireApprovedMerchant } from '../middleware/requireApprovedMerchant.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireMerchantIdPg } from '../services/merchantPg.js';
import {
  postBetweenWalletsPg,
  reverseWalletPostingPg,
} from '../services/walletPostingPg.js';
import { computeSaleTotals } from '../money/saleTotals.js';
import {
  getCustomerWalletPg,
  getMerchantSalesWalletPg,
} from '../services/walletKindsPg.js';
import { saleCreateSchema, saleVoidSchema } from '../validation.js';

type SaleItem = {
  productId: string;
  name: string;
  quantity: number;
  price: string;
  subtotal: string;
  costPrice?: string;
};

type SaleRow = {
  id: string;
  merchant_id: string;
  items_json: string;
  total_cents: string;
  gross_total_cents?: string | null;
  payment_method: string;
  created_at: string;
  voided_at: string | null;
  void_reason: string | null;
  discount_cents: string | null;
  receipt_number: string | null;
};

function toSaleDto(row: SaleRow) {
  const net = parseIntegerCents(row.total_cents, { allowZero: true });
  const discount = parseIntegerCents(row.discount_cents ?? '0', { allowZero: true });
  const gross = row.gross_total_cents
    ? parseIntegerCents(row.gross_total_cents, { allowZero: true })
    : ((net + discount) as typeof net);
  return {
    id: row.id,
    merchantId: row.merchant_id,
    items: JSON.parse(row.items_json) as SaleItem[],
    total: formatCents(net),
    gross: formatCents(gross),
    paymentMethod: row.payment_method,
    createdAt: row.created_at,
    voidedAt: row.voided_at,
    voidReason: row.void_reason,
    discount: formatCents(discount),
    receiptNumber: row.receipt_number,
  };
}

function receiptNumberFor(saleId: string, createdAt: string): string {
  return `KP-${createdAt.slice(0, 10).replaceAll('-', '')}-${saleId.slice(0, 8).toUpperCase()}`;
}

export const salesRouterPg = Router();
salesRouterPg.use(requireAuth, requireApprovedMerchant);

salesRouterPg.get('/sales', async (req, res) => {
  const pool = getPgPool();
  let merchantId: string;
  try {
    merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }

  const rows = await pool.query<SaleRow>(
    `SELECT id, merchant_id, items_json, total_cents, payment_method, created_at,
            voided_at, void_reason, discount_cents, receipt_number,
            COALESCE(gross_total_cents, total_cents) AS gross_total_cents
       FROM sales WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [merchantId],
  );

  return res.json({ sales: rows.rows.map(toSaleDto) });
});

salesRouterPg.post('/sales', idempotentPg('POST /sales'), async (req, res) => {
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

  const { items, paymentMethod, customerPhone, discount } = parsed.data;
  const discountCents = discount
    ? parseZarToCents(discount, { allowZero: true })
    : (0n as Cents);
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

  const merchantWallet = await getMerchantSalesWalletPg(pool, merchantUser.user_id);
  if (!merchantWallet) {
    return res.status(400).json({ error: 'Merchant wallet missing' });
  }

  const saleItems: SaleItem[] = [];
  let grossTotalCents = 0n as Cents;
  let netTotalCents = 0n as Cents;
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
        cost_price_cents: string;
      }>(`SELECT id, merchant_id, name, stock, cost_price_cents FROM products WHERE id = $1`, [
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

      const costAtSaleCents = parseIntegerCents(product.cost_price_cents, {
        allowZero: true,
      });
      const priceCents = parseZarToCents(line.price, { allowZero: true });
      const subtotalCents = multiplyCentsByQuantity(priceCents, line.quantity);
      grossTotalCents = (grossTotalCents + subtotalCents) as Cents;
      saleItems.push({
        productId: product.id,
        name: product.name,
        quantity: line.quantity,
        price: formatCents(priceCents),
        subtotal: formatCents(subtotalCents),
        costPrice: formatCents(costAtSaleCents),
      });

      await client.query(`UPDATE products SET stock = stock - $1 WHERE id = $2`, [
        line.quantity,
        product.id,
      ]);

      const movementId = randomUUID();
      await client.query(
        `INSERT INTO stock_movements
          (id, merchant_id, product_id, product_name, type, quantity, reason, cost_price_at_time_cents, reference, notes, created_at)
         VALUES ($1, $2, $3, $4, 'out', $5, 'sale', $6, $7, NULL, $8)`,
        [
          movementId,
          merchantId,
          product.id,
          product.name,
          line.quantity,
          costAtSaleCents.toString(),
          saleId,
          createdAt,
        ],
      );
    }

    const totals = computeSaleTotals(grossTotalCents, discountCents);
    netTotalCents = totals.netTotalCents;

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

      const customerWallet = await getCustomerWalletPg(client, customer.id);
      if (!customerWallet) {
        throw Object.assign(new Error('Customer wallet missing'), { status: 400 });
      }

      if (totals.netTotalCents > 0n) {
        await postBetweenWalletsPg(client, {
          fromWalletId: customerWallet.id,
          toWalletId: merchantWallet.id,
          amountCents: totals.netTotalCents,
          type: 'payment',
          referencePrefix: 'PAY',
          description: `Sale ${saleId}`,
        });
      }
    }

    const receiptNumber = receiptNumberFor(saleId, createdAt);
    await client.query(
      `INSERT INTO sales (id, merchant_id, items_json, total_cents, payment_method, created_at,
                          discount_cents, receipt_number, gross_total_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        saleId,
        merchantId,
        JSON.stringify(saleItems),
        totals.netTotalCents.toString(),
        paymentMethod,
        createdAt,
        totals.discountCents.toString(),
        receiptNumber,
        totals.grossTotalCents.toString(),
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
      total: formatCents(netTotalCents),
      gross: formatCents(grossTotalCents),
      paymentMethod,
      createdAt,
      voidedAt: null,
      discount: formatCents(discountCents),
      receiptNumber: receiptNumberFor(saleId, createdAt),
    },
  });
});

salesRouterPg.post('/sales/:id/void', idempotentPg('POST /sales/:id/void'), async (req, res) => {
  const parsed = saleVoidSchema.safeParse(req.body ?? {});
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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const saleQ = await client.query<SaleRow>(
      `SELECT id, merchant_id, items_json, total_cents, payment_method, created_at,
              voided_at, void_reason, discount_cents, receipt_number,
              COALESCE(gross_total_cents, total_cents) AS gross_total_cents
         FROM sales WHERE id = $1 AND merchant_id = $2 FOR UPDATE`,
      [req.params.id, merchantId],
    );
    const sale = saleQ.rows[0];
    if (!sale) {
      throw Object.assign(new Error('Sale not found'), { status: 404 });
    }
    if (sale.voided_at) {
      throw Object.assign(new Error('Sale is already voided'), { status: 409 });
    }
    const items = JSON.parse(sale.items_json) as SaleItem[];
    const now = new Date().toISOString();
    for (const line of items) {
      await client.query(`UPDATE products SET stock = stock + $1 WHERE id = $2 AND merchant_id = $3`, [
        line.quantity,
        line.productId,
        merchantId,
      ]);
      await client.query(
        `INSERT INTO stock_movements
          (id, merchant_id, product_id, product_name, type, quantity,           reason, cost_price_at_time_cents, reference, notes, created_at)
         VALUES ($1, $2, $3, $4, 'in', $5, 'manual', $6, $7, $8, $9)`,
        [
          randomUUID(),
          merchantId,
          line.productId,
          line.name,
          line.quantity,
          parseZarToCents(line.costPrice ?? '0', { allowZero: true }).toString(),
          sale.id,
          parsed.data.reason ?? 'Sale voided',
          now,
        ],
      );
    }

    if (sale.payment_method === 'wallet') {
      const merchantUserQ = await client.query<{ user_id: string }>(
        `SELECT user_id FROM merchants WHERE id = $1`,
        [merchantId],
      );
      const merchantWallet = merchantUserQ.rows[0]?.user_id
        ? await getMerchantSalesWalletPg(client, merchantUserQ.rows[0].user_id)
        : null;
      const originalPay = await client.query<{ id: string }>(
        `SELECT id FROM transactions
          WHERE type = 'payment' AND description = $1
          ORDER BY created_at DESC LIMIT 1`,
        [`Sale ${sale.id}`],
      );
      if (originalPay.rows[0] && merchantWallet) {
        const refundable = parseIntegerCents(sale.total_cents, { allowZero: true });
        if (refundable > 0n) {
          await reverseWalletPostingPg(client, {
            originalTransactionId: originalPay.rows[0].id,
            amountCents: refundable,
            kind: 'refund',
            referencePrefix: 'VOID',
            description: `Void sale ${sale.id}`,
          });
        }
      }
    }

    await client.query(
      `UPDATE sales SET voided_at = $1, void_reason = $2 WHERE id = $3`,
      [now, parsed.data.reason ?? 'Sale voided', sale.id],
    );
    await client.query('COMMIT');
    sale.voided_at = now;
    sale.void_reason = parsed.data.reason ?? 'Sale voided';
    return res.json({ sale: toSaleDto(sale) });
  } catch (e: unknown) {
    await client.query('ROLLBACK');
    const err = e as { status?: number; message?: string };
    const status = typeof err.status === 'number' ? err.status : 500;
    if (status >= 500) throw e;
    return res.status(status).json({ error: err.message ?? 'Void failed' });
  } finally {
    client.release();
  }
});
