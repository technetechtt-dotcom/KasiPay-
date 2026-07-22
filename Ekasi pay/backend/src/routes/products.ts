import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import { getDb } from '../db.js';
import { toProduct } from '../mappers.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireApprovedMerchant } from '../middleware/requireApprovedMerchant.js';
import { requireMerchantId } from '../services/merchant.js';
import { lookupBarcodeInCatalog } from '../services/barcodeCatalog.js';
import { productCreateSchema, productUpdateSchema } from '../validation.js';

export const productsRouter = Router();
productsRouter.use(requireAuth, requireApprovedMerchant);

const barcodeQuery = z.object({
  code: z.string().min(4).max(32),
});

productsRouter.get('/products/barcode-lookup', requireAuth, async (req, res) => {
  const parsed = barcodeQuery.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const hit = await lookupBarcodeInCatalog(parsed.data.code);
  return res.json(hit);
});

productsRouter.get('/products', requireAuth, (req, res) => {
  const merchantId = typeof req.query.merchantId === 'string'
    ? req.query.merchantId
    : '';
  if (!merchantId) {
    return res.status(400).json({ error: 'merchantId query required' });
  }
  const database = getDb();
  const rows = database
    .prepare('SELECT * FROM products WHERE merchant_id = ? ORDER BY name COLLATE NOCASE')
    .all(merchantId) as {
    id: string;
    merchant_id: string;
    name: string;
    cost_price: number;
    price: number;
    stock: number;
    category: string;
    barcode: string | null;
  }[];
  return res.json({ products: rows.map(toProduct) });
});

productsRouter.post('/products', requireAuth, (req, res) => {
  const parsed = productCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const merchantId = requireMerchantId(req.auth!.userId);
    const database = getDb();
    const id = randomUUID();
    const p = parsed.data;
    database
      .prepare(
        `INSERT INTO products (id, merchant_id, name, cost_price, price, stock, category, barcode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        merchantId,
        p.name,
        p.costPrice,
        p.price,
        p.stock,
        p.category,
        p.barcode ?? null
      );
    const row = database.prepare('SELECT * FROM products WHERE id = ?').get(id) as {
      id: string;
      merchant_id: string;
      name: string;
      cost_price: number;
      price: number;
      stock: number;
      category: string;
      barcode: string | null;
    };
    return res.status(201).json({ product: toProduct(row) });
  } catch (e: unknown) {
    const err = e as { status?: number };
    if (err.status === 403) {
      return res.status(403).json({ error: 'Merchant profile required' });
    }
    throw e;
  }
});

productsRouter.patch('/products/:id', requireAuth, (req, res) => {
  const parsed = productUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const productId = req.params.id;
  const database = getDb();
  let merchantId: string;
  try {
    merchantId = requireMerchantId(req.auth!.userId);
  } catch (e: unknown) {
    const err = e as { status?: number };
    if (err.status === 403) {
      return res.status(403).json({ error: 'Merchant profile required' });
    }
    throw e;
  }
  const existing = database.prepare('SELECT * FROM products WHERE id = ?').get(productId) as
    | {
        id: string;
        merchant_id: string;
        name: string;
        cost_price: number;
        price: number;
        stock: number;
        category: string;
        barcode: string | null;
      }
    | undefined;
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
    barcode:
      parsed.data.barcode !== undefined
        ? parsed.data.barcode
        : existing.barcode,
  };
  database
    .prepare(
      `UPDATE products SET name = ?, cost_price = ?, price = ?, stock = ?, category = ?, barcode = ?
       WHERE id = ?`
    )
    .run(
      next.name,
      next.cost_price,
      next.price,
      next.stock,
      next.category,
      next.barcode ?? null,
      productId
    );
  const row = database.prepare('SELECT * FROM products WHERE id = ?').get(productId) as {
    id: string;
    merchant_id: string;
    name: string;
    cost_price: number;
    price: number;
    stock: number;
    category: string;
    barcode: string | null;
  };
  return res.json({ product: toProduct(row) });
});
