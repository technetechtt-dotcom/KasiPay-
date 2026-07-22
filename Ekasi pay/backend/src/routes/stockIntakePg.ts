import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import type { PoolClient } from 'pg';

import { getPgPool } from '../dbPg.js';
import { toProduct } from '../mappers.js';
import {
  formatCents,
  multiplyCentsByQuantity,
  multiplyCentsByRate,
  parseFixedRate,
  parseIntegerCents,
  parseZarToCents,
  type Cents,
} from '../money.js';
import { requireApprovedMerchant } from '../middleware/requireApprovedMerchant.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireMerchantIdPg } from '../services/merchantPg.js';
import { stockIntakeBodySchema } from '../validation.js';

type IntakeLineResult = {
  productId: string;
  name: string;
  quantity: number;
  costPrice: string;
  lineTotal: string;
};

type SlipRow = {
  id: string;
  merchant_id: string;
  supplier_name: string | null;
  slip_reference: string | null;
  total_cents: string;
  line_items_json: string;
  notes: string | null;
  expense_id: string | null;
  created_at: string;
};

export const stockIntakeRouterPg = Router();

stockIntakeRouterPg.use(requireAuth, requireApprovedMerchant);

function toPurchaseSlip(row: SlipRow) {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    supplierName: row.supplier_name ?? undefined,
    slipReference: row.slip_reference ?? undefined,
    total: formatCents(parseIntegerCents(row.total_cents)),
    lineItems: JSON.parse(row.line_items_json) as IntakeLineResult[],
    notes: row.notes ?? undefined,
    expenseId: row.expense_id ?? undefined,
    createdAt: row.created_at,
  };
}

async function applyStockIntakePg(
  client: PoolClient,
  merchantId: string,
  body: ReturnType<typeof stockIntakeBodySchema.parse>,
) {
  const slipId = randomUUID();
  const now = new Date().toISOString();
  const lineResults: IntakeLineResult[] = [];
  const updatedProducts: ReturnType<typeof toProduct>[] = [];
  const movements: string[] = [];

  for (const line of body.lines) {
    let product:
      | {
          id: string;
          merchant_id: string;
          name: string;
          cost_price_cents: string;
          price_cents: string;
          stock: number;
          category: string;
          barcode: string | null;
        }
      | undefined;

    if (line.productId) {
      const productQ = await client.query<{
        id: string;
        merchant_id: string;
        name: string;
        cost_price_cents: string;
        price_cents: string;
        stock: number;
        category: string;
        barcode: string | null;
      }>(`SELECT * FROM products WHERE id = $1`, [line.productId]);
      product = productQ.rows[0];
      if (!product) {
        throw Object.assign(new Error('Product not found'), { status: 404 });
      }
      if (product.merchant_id !== merchantId) {
        throw Object.assign(new Error('Product not in your store'), { status: 403 });
      }

      const nextStock = product.stock + line.quantity;
      await client.query(
        `UPDATE products
            SET stock = $1, cost_price_cents = $2
          WHERE id = $3`,
        [
          nextStock,
          parseZarToCents(line.costPrice, { allowZero: true }).toString(),
          product.id,
        ],
      );
      product = {
        ...product,
        stock: nextStock,
        cost_price_cents: parseZarToCents(line.costPrice, {
          allowZero: true,
        }).toString(),
      };
    } else {
      const id = randomUUID();
      const costCents = parseZarToCents(line.costPrice, { allowZero: true });
      const sellingPriceCents =
        line.sellingPrice === undefined
          ? multiplyCentsByRate(costCents, parseFixedRate('1.2'))
          : parseZarToCents(line.sellingPrice);
      await client.query(
        `INSERT INTO products (id, merchant_id, name, cost_price_cents, price_cents, stock, category, barcode)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          merchantId,
          line.name!,
          costCents.toString(),
          sellingPriceCents.toString(),
          line.quantity,
          line.category!,
          line.barcode ?? null,
        ],
      );
      const rowQ = await client.query<{
        id: string;
        merchant_id: string;
        name: string;
        cost_price_cents: string;
        price_cents: string;
        stock: number;
        category: string;
        barcode: string | null;
      }>(`SELECT * FROM products WHERE id = $1`, [id]);
      product = rowQ.rows[0];
    }

    const movementId = randomUUID();
    await client.query(
      `INSERT INTO stock_movements
        (id, merchant_id, product_id, product_name, type, quantity, reason, cost_price_at_time_cents, reference, notes, created_at)
       VALUES ($1, $2, $3, $4, 'in', $5, 'restock', $6, $7, $8, $9)`,
      [
        movementId,
        merchantId,
        product.id,
        product.name,
        line.quantity,
        parseZarToCents(line.costPrice, { allowZero: true }).toString(),
        slipId,
        body.notes ?? null,
        now,
      ],
    );
    movements.push(movementId);

    const costCents = parseZarToCents(line.costPrice, { allowZero: true });
    const lineTotalCents = multiplyCentsByQuantity(costCents, line.quantity);
    lineResults.push({
      productId: product.id,
      name: product.name,
      quantity: line.quantity,
      costPrice: formatCents(costCents),
      lineTotal: formatCents(lineTotalCents),
    });
    updatedProducts.push(toProduct(product));
  }

  const computedTotalCents = body.lines.reduce(
    (sum, line) =>
      (sum +
        multiplyCentsByQuantity(
          parseZarToCents(line.costPrice, { allowZero: true }),
          line.quantity,
        )) as Cents,
    0n as Cents,
  );
  const slipTotalCents =
    body.slipTotal === undefined
      ? computedTotalCents
      : parseZarToCents(body.slipTotal);
  let expenseId: string | null = null;

  if (body.recordExpense !== false && slipTotalCents > 0n) {
    expenseId = randomUUID();
    const supplier = body.supplierName?.trim() || 'Supplier';
    const ref = body.slipReference?.trim();
    const description = ref
      ? `Stock purchase — ${supplier} (slip ${ref})`
      : `Stock purchase — ${supplier}`;
    await client.query(
      `INSERT INTO expenses (id, merchant_id, category, description, amount_cents, created_at)
       VALUES ($1, $2, 'supplier', $3, $4, $5)`,
      [expenseId, merchantId, description, slipTotalCents.toString(), now],
    );
  }

  await client.query(
    `INSERT INTO purchase_slips
      (id, merchant_id, supplier_name, slip_reference, total_cents, line_items_json, notes, expense_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      slipId,
      merchantId,
      body.supplierName?.trim() || null,
      body.slipReference?.trim() || null,
      slipTotalCents.toString(),
      JSON.stringify(lineResults),
      body.notes ?? null,
      expenseId,
      now,
    ],
  );

  const slipQ = await client.query<SlipRow>(
    `SELECT * FROM purchase_slips WHERE id = $1`,
    [slipId],
  );

  return {
    slip: toPurchaseSlip(slipQ.rows[0]),
    products: updatedProducts,
    movementIds: movements,
  };
}

stockIntakeRouterPg.get('/purchase-slips', requireAuth, async (req, res) => {
  const pool = getPgPool();
  let merchantId: string;
  try {
    merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }

  const rows = await pool.query<SlipRow>(
    `SELECT * FROM purchase_slips
      WHERE merchant_id = $1
      ORDER BY created_at DESC
      LIMIT 200`,
    [merchantId],
  );
  return res.json({ slips: rows.rows.map(toPurchaseSlip) });
});

stockIntakeRouterPg.post('/stock-intake', requireAuth, async (req, res) => {
  const parsed = stockIntakeBodySchema.safeParse(req.body);
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
    const result = await applyStockIntakePg(client, merchantId, parsed.data);
    await client.query('COMMIT');
    return res.status(201).json(result);
  } catch (e: unknown) {
    await client.query('ROLLBACK');
    const err = e as { status?: number; message?: string };
    const status = typeof err.status === 'number' ? err.status : 500;
    const message = err.message ?? 'Stock intake failed';
    if (status >= 500) throw e;
    return res.status(status).json({ error: message });
  } finally {
    client.release();
  }
});
