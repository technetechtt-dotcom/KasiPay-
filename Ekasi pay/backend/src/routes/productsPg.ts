import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import { getPgPool } from '../dbPg.js';
import { toProduct } from '../mappers.js';
import { requireApprovedMerchant } from '../middleware/requireApprovedMerchant.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireMerchantIdPg } from '../services/merchantPg.js';
import { lookupBarcodeInCatalog } from '../services/barcodeCatalog.js';
import { productCreateSchema, productUpdateSchema } from '../validation.js';

export const productsRouterPg = Router();

productsRouterPg.use(requireAuth, requireApprovedMerchant);

const barcodeQuery = z.object({
  code: z.string().min(4).max(32),
});

productsRouterPg.get('/products/barcode-lookup', requireAuth, async (req, res) => {
  const parsed = barcodeQuery.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const hit = await lookupBarcodeInCatalog(parsed.data.code);
  return res.json(hit);
});

productsRouterPg.get('/products', requireAuth, async (req, res) => {
  const merchantId = typeof req.query.merchantId === 'string' ? req.query.merchantId : '';
  if (!merchantId) {
    return res.status(400).json({ error: 'merchantId query required' });
  }
  const pool = getPgPool();
  const rows = await pool.query<{
    id: string;
    merchant_id: string;
    name: string;
    cost_price: number;
    price: number;
    stock: number;
    category: string;
    barcode: string | null;
  }>(
    `SELECT * FROM products WHERE merchant_id = $1 ORDER BY lower(name)`,
    [merchantId],
  );
  return res.json({ products: rows.rows.map(toProduct) });
});

productsRouterPg.post('/products', requireAuth, async (req, res) => {
  const parsed = productCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const pool = getPgPool();
  try {
    const merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
    const id = randomUUID();
    const p = parsed.data;
    await pool.query(
      `INSERT INTO products (id, merchant_id, name, cost_price, price, stock, category, barcode)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        merchantId,
        p.name,
        p.costPrice,
        p.price,
        p.stock,
        p.category,
        p.barcode ?? null,
      ],
    );
    const row = await pool.query<{
      id: string;
      merchant_id: string;
      name: string;
      cost_price: number;
      price: number;
      stock: number;
      category: string;
      barcode: string | null;
    }>(`SELECT * FROM products WHERE id = $1`, [id]);
    return res.status(201).json({ product: toProduct(row.rows[0]) });
  } catch (e: unknown) {
    const err = e as { status?: number };
    if (err.status === 403) {
      return res.status(403).json({ error: 'Merchant profile required' });
    }
    throw e;
  }
});

productsRouterPg.patch('/products/:id', requireAuth, async (req, res) => {
  const parsed = productUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const productId = req.params.id;
  const pool = getPgPool();
  let merchantId: string;
  try {
    merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
  } catch (e: unknown) {
    const err = e as { status?: number };
    if (err.status === 403) {
      return res.status(403).json({ error: 'Merchant profile required' });
    }
    throw e;
  }

  const existingQ = await pool.query<{
    id: string;
    merchant_id: string;
    name: string;
    cost_price: number;
    price: number;
    stock: number;
    category: string;
    barcode: string | null;
  }>(`SELECT * FROM products WHERE id = $1`, [productId]);
  const existing = existingQ.rows[0];
  if (!existing) {
    return res.status(404).json({ error: 'Product not found' });
  }
  if (existing.merchant_id !== merchantId) {
    return res.status(403).json({ error: 'Not allowed to update this product' });
  }

  const next = {
    name: parsed.data.name ?? existing.name,
    cost_price: parsed.data.costPrice ?? existing.cost_price,
    price: parsed.data.price ?? existing.price,
    stock: parsed.data.stock ?? existing.stock,
    category: parsed.data.category ?? existing.category,
    barcode: parsed.data.barcode !== undefined ? parsed.data.barcode : existing.barcode,
  };

  await pool.query(
    `UPDATE products
        SET name = $1, cost_price = $2, price = $3, stock = $4, category = $5, barcode = $6
      WHERE id = $7`,
    [
      next.name,
      next.cost_price,
      next.price,
      next.stock,
      next.category,
      next.barcode ?? null,
      productId,
    ],
  );

  const row = await pool.query<{
    id: string;
    merchant_id: string;
    name: string;
    cost_price: number;
    price: number;
    stock: number;
    category: string;
    barcode: string | null;
  }>(`SELECT * FROM products WHERE id = $1`, [productId]);
  return res.json({ product: toProduct(row.rows[0]) });
});
