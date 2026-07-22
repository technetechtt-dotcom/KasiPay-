import { randomUUID } from 'node:crypto';

import { Router } from 'express';

import { getDb } from '../db.js';
import { toProduct } from '../mappers.js';
import { requireApprovedMerchant } from '../middleware/requireApprovedMerchant.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireMerchantId } from '../services/merchant.js';
import { stockIntakeBodySchema } from '../validation.js';

type IntakeLineResult = {
  productId: string;
  name: string;
  quantity: number;
  costPrice: number;
  lineTotal: number;
};

type SlipRow = {
  id: string;
  merchant_id: string;
  supplier_name: string | null;
  slip_reference: string | null;
  total: number;
  line_items_json: string;
  notes: string | null;
  expense_id: string | null;
  created_at: string;
};

function toPurchaseSlip(row: SlipRow) {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    supplierName: row.supplier_name ?? undefined,
    slipReference: row.slip_reference ?? undefined,
    total: row.total,
    lineItems: JSON.parse(row.line_items_json) as IntakeLineResult[],
    notes: row.notes ?? undefined,
    expenseId: row.expense_id ?? undefined,
    createdAt: row.created_at,
  };
}

function applyStockIntake(
  database: ReturnType<typeof getDb>,
  merchantId: string,
  body: ReturnType<typeof stockIntakeBodySchema.parse>,
) {
  const slipId = randomUUID();
  const now = new Date().toISOString();
  const lineResults: IntakeLineResult[] = [];
  const updatedProducts: ReturnType<typeof toProduct>[] = [];
  const movementIds: string[] = [];

  for (const line of body.lines) {
    let product:
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

    if (line.productId) {
      product = database
        .prepare(`SELECT * FROM products WHERE id = ?`)
        .get(line.productId) as typeof product;
      if (!product) {
        throw Object.assign(new Error('Product not found'), { status: 404 });
      }
      if (product.merchant_id !== merchantId) {
        throw Object.assign(new Error('Product not in your store'), { status: 403 });
      }
      const nextStock = product.stock + line.quantity;
      database
        .prepare(`UPDATE products SET stock = ?, cost_price = ? WHERE id = ?`)
        .run(nextStock, line.costPrice, product.id);
      product = { ...product, stock: nextStock, cost_price: line.costPrice };
    } else {
      const id = randomUUID();
      const sellingPrice = line.sellingPrice ?? line.costPrice * 1.2;
      database
        .prepare(
          `INSERT INTO products (id, merchant_id, name, cost_price, price, stock, category, barcode)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          merchantId,
          line.name!,
          line.costPrice,
          sellingPrice,
          line.quantity,
          line.category!,
          line.barcode ?? null,
        );
      product = database
        .prepare(`SELECT * FROM products WHERE id = ?`)
        .get(id) as typeof product;
    }

    const movementId = randomUUID();
    database
      .prepare(
        `INSERT INTO stock_movements
          (id, merchant_id, product_id, product_name, type, quantity, reason, cost_price_at_time, reference, notes, created_at)
         VALUES (?, ?, ?, ?, 'in', ?, 'restock', ?, ?, ?, ?)`,
      )
      .run(
        movementId,
        merchantId,
        product!.id,
        product!.name,
        line.quantity,
        line.costPrice,
        slipId,
        body.notes ?? null,
        now,
      );
    movementIds.push(movementId);

    const lineTotal = line.quantity * line.costPrice;
    lineResults.push({
      productId: product!.id,
      name: product!.name,
      quantity: line.quantity,
      costPrice: line.costPrice,
      lineTotal: Number(lineTotal.toFixed(2)),
    });
    updatedProducts.push(toProduct(product!));
  }

  const computedTotal = lineResults.reduce((s, l) => s + l.lineTotal, 0);
  const slipTotal = body.slipTotal ?? computedTotal;
  let expenseId: string | null = null;

  if (body.recordExpense !== false && slipTotal > 0) {
    expenseId = randomUUID();
    const supplier = body.supplierName?.trim() || 'Supplier';
    const ref = body.slipReference?.trim();
    const description = ref
      ? `Stock purchase — ${supplier} (slip ${ref})`
      : `Stock purchase — ${supplier}`;
    database
      .prepare(
        `INSERT INTO expenses (id, merchant_id, category, description, amount, created_at)
         VALUES (?, ?, 'supplier', ?, ?, ?)`,
      )
      .run(expenseId, merchantId, description, slipTotal, now);
  }

  database
    .prepare(
      `INSERT INTO purchase_slips
        (id, merchant_id, supplier_name, slip_reference, total, line_items_json, notes, expense_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      slipId,
      merchantId,
      body.supplierName?.trim() || null,
      body.slipReference?.trim() || null,
      slipTotal,
      JSON.stringify(lineResults),
      body.notes ?? null,
      expenseId,
      now,
    );

  const slip = database
    .prepare(`SELECT * FROM purchase_slips WHERE id = ?`)
    .get(slipId) as SlipRow;

  return {
    slip: toPurchaseSlip(slip),
    products: updatedProducts,
    movementIds,
  };
}

export const stockIntakeRouter = Router();
stockIntakeRouter.use(requireAuth, requireApprovedMerchant);

stockIntakeRouter.get('/purchase-slips', requireAuth, (req, res) => {
  let merchantId: string;
  try {
    merchantId = requireMerchantId(req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const database = getDb();
  const rows = database
    .prepare(
      `SELECT * FROM purchase_slips
        WHERE merchant_id = ?
        ORDER BY datetime(created_at) DESC
        LIMIT 200`,
    )
    .all(merchantId) as SlipRow[];
  return res.json({ slips: rows.map(toPurchaseSlip) });
});

stockIntakeRouter.post('/stock-intake', requireAuth, (req, res) => {
  const parsed = stockIntakeBodySchema.safeParse(req.body);
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
  try {
    const result = database.transaction(() =>
      applyStockIntake(database, merchantId, parsed.data),
    )();
    return res.status(201).json(result);
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string };
    const status = typeof err.status === 'number' ? err.status : 500;
    const message = err.message ?? 'Stock intake failed';
    if (status >= 500) throw e;
    return res.status(status).json({ error: message });
  }
});
