import { Router } from 'express';
import { z } from 'zod';

import { getPgPool } from '../dbPg.js';
import {
  formatCents,
  multiplyCentsByQuantity,
  multiplyCentsByRate,
  parseFixedRate,
  parseIntegerCents,
  parseZarToCents,
  type Cents,
} from '../money.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireMerchantIdPg } from '../services/merchantPg.js';

export const analyticsRouterPg = Router();

type SaleItem = {
  productId: string;
  name: string;
  quantity: number;
  price: string | number;
  subtotal: string | number;
  costPrice?: string | number;
};

type SaleRow = {
  id: string;
  items_json: string;
  total_cents: string;
  payment_method: string;
  created_at: string;
};

type ExpenseRow = {
  id: string;
  category: string;
  description: string;
  amount_cents: string;
  created_at: string;
};

type ProductRow = {
  id: string;
  cost_price_cents: string | null;
  stock: number;
};

const periodSchema = z
  .enum(['daily', 'weekly', 'monthly', 'yearly', 'all'])
  .default('monthly');

function periodStart(period: z.infer<typeof periodSchema>): string | null {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const since = new Date(today);
  switch (period) {
    case 'daily':
      break;
    case 'weekly':
      since.setDate(since.getDate() - 7);
      break;
    case 'monthly':
      since.setMonth(since.getMonth() - 1);
      break;
    case 'yearly':
      since.setFullYear(since.getFullYear() - 1);
      break;
    case 'all':
      return null;
  }
  return since.toISOString();
}

analyticsRouterPg.get('/analytics/summary', requireAuth, async (req, res) => {
  const period = periodSchema.parse(req.query.period);
  const pool = getPgPool();
  const merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
  const since = periodStart(period);

  const sales = (
    since
      ? await pool.query<SaleRow>(
          `SELECT id, items_json, total_cents, payment_method, created_at
             FROM sales
            WHERE merchant_id = $1 AND created_at >= $2`,
          [merchantId, since],
        )
      : await pool.query<SaleRow>(
          `SELECT id, items_json, total_cents, payment_method, created_at
             FROM sales
            WHERE merchant_id = $1`,
          [merchantId],
        )
  ).rows;

  const totalRevenueCents = sales.reduce(
    (sum, sale) => sum + parseIntegerCents(sale.total_cents, { allowZero: true }),
    0n,
  );
  const transactionCount = sales.length;
  const avgOrderCents =
    transactionCount > 0
      ? (totalRevenueCents + BigInt(Math.floor(transactionCount / 2))) /
        BigInt(transactionCount)
      : 0n;

  type Agg = { name: string; quantity: number; revenueCents: bigint };
  const byProduct = new Map<string, Agg>();
  for (const sale of sales) {
    let items: SaleItem[] = [];
    try {
      items = JSON.parse(sale.items_json) as SaleItem[];
    } catch {
      continue;
    }
    for (const it of items) {
      const cur = byProduct.get(it.productId) ?? {
        name: it.name,
        quantity: 0,
        revenueCents: 0n,
      };
      cur.quantity += it.quantity;
      cur.revenueCents += parseZarToCents(it.subtotal, { allowZero: true });
      byProduct.set(it.productId, cur);
    }
  }
  const bestSellers = [...byProduct.entries()]
    .map(([productId, v]) => ({ productId, ...v }))
    .sort((a, b) => b.quantity - a.quantity)
    .slice(0, 5);

  const dayBuckets = new Map<string, bigint>();
  for (const sale of sales) {
    const d = new Date(sale.created_at);
    const key = d.toISOString().slice(0, 10);
    dayBuckets.set(
      key,
      (dayBuckets.get(key) ?? 0n) +
        parseIntegerCents(sale.total_cents, { allowZero: true }),
    );
  }
  const trend = [...dayBuckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-30)
    .map(([day, revenue]) => ({ day, revenue: formatCents(revenue) }));

  const atRisk = (
    await pool.query<{ id: string; name: string; stock: number }>(
      `SELECT id, name, stock
         FROM products
        WHERE merchant_id = $1
          AND stock > 0
          AND stock <= 5`,
      [merchantId],
    )
  ).rows;

  return res.json({
    period,
    rangeStart: since,
    totalRevenue: formatCents(totalRevenueCents),
    transactionCount,
    avgOrder: formatCents(avgOrderCents),
    bestSellers: bestSellers.map(({ revenueCents, ...seller }) => ({
      ...seller,
      revenue: formatCents(revenueCents),
    })),
    trend,
    atRiskProducts: atRisk,
  });
});

analyticsRouterPg.get('/reports/income-statement', requireAuth, async (req, res) => {
  const period = periodSchema.parse(req.query.period);
  const pool = getPgPool();
  const merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
  const since = periodStart(period);

  const sales = (
    since
      ? await pool.query<SaleRow>(
          `SELECT id, items_json, total_cents, payment_method, created_at
             FROM sales
            WHERE merchant_id = $1 AND created_at >= $2`,
          [merchantId, since],
        )
      : await pool.query<SaleRow>(
          `SELECT id, items_json, total_cents, payment_method, created_at
             FROM sales
            WHERE merchant_id = $1`,
          [merchantId],
        )
  ).rows;

  const expenses = (
    since
      ? await pool.query<ExpenseRow>(
          `SELECT id, category, description, amount_cents, created_at
             FROM expenses
            WHERE merchant_id = $1 AND created_at >= $2`,
          [merchantId, since],
        )
      : await pool.query<ExpenseRow>(
          `SELECT id, category, description, amount_cents, created_at
             FROM expenses
            WHERE merchant_id = $1`,
          [merchantId],
        )
  ).rows;

  const products = (
    await pool.query<ProductRow>(
      `SELECT id, cost_price_cents, stock FROM products WHERE merchant_id = $1`,
      [merchantId],
    )
  ).rows;
  const productById = new Map(products.map((p) => [p.id, p]));

  const totalRevenueCents = sales.reduce(
    (sum, sale) => sum + parseIntegerCents(sale.total_cents, { allowZero: true }),
    0n,
  );
  let totalCogsCents = 0n as Cents;
  for (const sale of sales) {
    let items: SaleItem[] = [];
    try {
      items = JSON.parse(sale.items_json) as SaleItem[];
    } catch {
      continue;
    }
    for (const it of items) {
      const product = productById.get(it.productId);
      const costPriceCents =
        it.costPrice !== undefined
          ? parseZarToCents(it.costPrice, { allowZero: true })
          : product?.cost_price_cents != null
            ? parseIntegerCents(product.cost_price_cents, { allowZero: true })
            : multiplyCentsByRate(
                parseZarToCents(it.price, { allowZero: true }),
                parseFixedRate('0.7'),
              );
      totalCogsCents = (totalCogsCents +
        multiplyCentsByQuantity(costPriceCents, it.quantity)) as Cents;
    }
  }
  const grossProfitCents = totalRevenueCents - totalCogsCents;
  const grossMarginPct =
    totalRevenueCents > 0n
      ? Number((grossProfitCents * 10_000n) / totalRevenueCents) / 100
      : 0;

  const expensesByCategory = new Map<string, bigint>();
  for (const e of expenses) {
    expensesByCategory.set(
      e.category,
      (expensesByCategory.get(e.category) ?? 0n) +
        parseIntegerCents(e.amount_cents, { allowZero: true }),
    );
  }
  const totalExpensesCents = expenses.reduce(
    (sum, expense) =>
      sum + parseIntegerCents(expense.amount_cents, { allowZero: true }),
    0n,
  );
  const netProfitCents = grossProfitCents - totalExpensesCents;
  const netMarginPct =
    totalRevenueCents > 0n
      ? Number((netProfitCents * 10_000n) / totalRevenueCents) / 100
      : 0;

  return res.json({
    period,
    rangeStart: since,
    totalRevenue: formatCents(totalRevenueCents),
    totalCOGS: formatCents(totalCogsCents),
    grossProfit: formatCents(grossProfitCents),
    grossMarginPct,
    totalExpenses: formatCents(totalExpensesCents),
    expensesByCategory: [...expensesByCategory.entries()].map(([category, amount]) => ({
      category,
      amount: formatCents(amount),
    })),
    netProfit: formatCents(netProfitCents),
    netMarginPct,
    saleCount: sales.length,
    expenseCount: expenses.length,
  });
});

analyticsRouterPg.get('/reports/expense-statement', requireAuth, async (req, res) => {
  const period = periodSchema.parse(req.query.period);
  const pool = getPgPool();
  const merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
  const since = periodStart(period);

  const expenses = (
    since
      ? await pool.query<ExpenseRow>(
          `SELECT id, category, description, amount_cents, created_at
             FROM expenses
            WHERE merchant_id = $1 AND created_at >= $2
            ORDER BY created_at DESC`,
          [merchantId, since],
        )
      : await pool.query<ExpenseRow>(
          `SELECT id, category, description, amount_cents, created_at
             FROM expenses
            WHERE merchant_id = $1
            ORDER BY created_at DESC`,
          [merchantId],
        )
  ).rows;

  const expensesByCategory = new Map<string, bigint>();
  for (const e of expenses) {
    expensesByCategory.set(
      e.category,
      (expensesByCategory.get(e.category) ?? 0n) +
        parseIntegerCents(e.amount_cents, { allowZero: true }),
    );
  }
  const totalExpensesCents = expenses.reduce(
    (sum, expense) =>
      sum + parseIntegerCents(expense.amount_cents, { allowZero: true }),
    0n,
  );

  return res.json({
    period,
    rangeStart: since,
    totalExpenses: formatCents(totalExpensesCents),
    expensesByCategory: [...expensesByCategory.entries()].map(([category, amount]) => ({
      category,
      amount: formatCents(amount),
    })),
    expenses: expenses.map((e) => ({
      id: e.id,
      category: e.category,
      description: e.description,
      amount: formatCents(
        parseIntegerCents(e.amount_cents, { allowZero: true }),
      ),
      createdAt: e.created_at,
    })),
    expenseCount: expenses.length,
  });
});

analyticsRouterPg.get('/reports/inventory', requireAuth, async (req, res) => {
  const pool = getPgPool();
  const merchantId = await requireMerchantIdPg(pool, req.auth!.userId);

  const rows = await pool.query<{
    id: string;
    name: string;
    cost_price_cents: string;
    price_cents: string;
    stock: number;
    category: string;
    barcode: string | null;
  }>(
    `SELECT id, name, cost_price_cents, price_cents, stock, category, barcode
       FROM products
      WHERE merchant_id = $1
      ORDER BY lower(category), lower(name)`,
    [merchantId],
  );

  const items = rows.rows.map((p) => {
    const costPriceCents = parseIntegerCents(p.cost_price_cents, {
      allowZero: true,
    });
    const priceCents = parseIntegerCents(p.price_cents, { allowZero: true });
    const costValueCents = multiplyCentsByQuantity(costPriceCents, p.stock);
    const retailValueCents = multiplyCentsByQuantity(priceCents, p.stock);
    return {
      id: p.id,
      name: p.name,
      category: p.category,
      barcode: p.barcode ?? undefined,
      stock: p.stock,
      costPrice: formatCents(costPriceCents),
      sellingPrice: formatCents(priceCents),
      costValue: formatCents(costValueCents),
      retailValue: formatCents(retailValueCents),
      marginPerUnit: formatCents(priceCents - costPriceCents),
      costValueCents,
      retailValueCents,
    };
  });

  const totalUnits = items.reduce((s, i) => s + i.stock, 0);
  const totalCostValueCents = items.reduce(
    (sum, item) => sum + item.costValueCents,
    0n,
  );
  const totalRetailValueCents = items.reduce(
    (sum, item) => sum + item.retailValueCents,
    0n,
  );
  const lowStockCount = items.filter((i) => i.stock > 0 && i.stock < 10).length;
  const outOfStockCount = items.filter((i) => i.stock === 0).length;

  return res.json({
    generatedAt: new Date().toISOString(),
    totalSkus: items.length,
    totalUnits,
    totalCostValue: formatCents(totalCostValueCents),
    totalRetailValue: formatCents(totalRetailValueCents),
    lowStockCount,
    outOfStockCount,
    items: items.map(({ costValueCents: _cost, retailValueCents: _retail, ...item }) => item),
  });
});
