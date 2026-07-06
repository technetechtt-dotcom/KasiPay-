import { Router } from 'express';
import { z } from 'zod';

import { getDb } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireMerchantId } from '../services/merchant.js';

export const analyticsRouter = Router();

type SaleItem = {
  productId: string;
  name: string;
  quantity: number;
  price: number;
  subtotal: number;
};

type SaleRow = {
  id: string;
  items_json: string;
  total: number;
  payment_method: string;
  created_at: string;
};

type ExpenseRow = {
  id: string;
  category: string;
  description: string;
  amount: number;
  created_at: string;
};

type ProductRow = {
  id: string;
  cost_price: number | null;
  stock: number;
};

const periodSchema = z
  .enum(['daily', 'weekly', 'monthly', 'yearly', 'all'])
  .default('monthly');

/** Return the inclusive ISO timestamp marking the start of the requested period. */
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

/**
 * GET /api/analytics/summary?period=monthly
 * Returns aggregates (revenue, sale count, average order, best sellers, etc.)
 * Computed in SQL/JS on the server so the client can't fudge the numbers.
 */
analyticsRouter.get('/analytics/summary', requireAuth, (req, res) => {
  const period = periodSchema.parse(req.query.period);
  const merchantId = requireMerchantId(req.auth!.userId);
  const database = getDb();
  const since = periodStart(period);

  const sales = (
    since
      ? database
          .prepare(
            `SELECT id, items_json, total, payment_method, created_at
               FROM sales
              WHERE merchant_id = ? AND datetime(created_at) >= datetime(?)`,
          )
          .all(merchantId, since)
      : database
          .prepare(
            `SELECT id, items_json, total, payment_method, created_at
               FROM sales WHERE merchant_id = ?`,
          )
          .all(merchantId)
  ) as SaleRow[];

  const totalRevenue = sales.reduce((s, r) => s + r.total, 0);
  const transactionCount = sales.length;
  const avgOrder = transactionCount > 0 ? totalRevenue / transactionCount : 0;

  type Agg = { name: string; quantity: number; revenue: number };
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
        revenue: 0,
      };
      cur.quantity += it.quantity;
      cur.revenue += it.subtotal;
      byProduct.set(it.productId, cur);
    }
  }
  const bestSellers = [...byProduct.entries()]
    .map(([productId, v]) => ({ productId, ...v }))
    .sort((a, b) => b.quantity - a.quantity)
    .slice(0, 5);

  const dayBuckets = new Map<string, number>();
  for (const sale of sales) {
    const d = new Date(sale.created_at);
    const key = d.toISOString().slice(0, 10);
    dayBuckets.set(key, (dayBuckets.get(key) ?? 0) + sale.total);
  }
  const trend = [...dayBuckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-30)
    .map(([day, revenue]) => ({ day, revenue: Number(revenue.toFixed(2)) }));

  const atRisk = database
    .prepare(
      `SELECT id, name, stock
         FROM products
        WHERE merchant_id = ?
          AND stock > 0
          AND stock <= 5`,
    )
    .all(merchantId) as { id: string; name: string; stock: number }[];

  return res.json({
    period,
    rangeStart: since,
    totalRevenue: Number(totalRevenue.toFixed(2)),
    transactionCount,
    avgOrder: Number(avgOrder.toFixed(2)),
    bestSellers: bestSellers.map((b) => ({
      ...b,
      revenue: Number(b.revenue.toFixed(2)),
    })),
    trend,
    atRiskProducts: atRisk,
  });
});

/**
 * GET /api/reports/income-statement?period=monthly
 * Server-side income statement: revenue, COGS, gross profit, operating expenses,
 * net profit + margin percentages. Costs come from products.cost_price (falling
 * back to a 70% assumption only as a last resort, mirroring the legacy UI).
 */
analyticsRouter.get('/reports/income-statement', requireAuth, (req, res) => {
  const period = periodSchema.parse(req.query.period);
  const merchantId = requireMerchantId(req.auth!.userId);
  const database = getDb();
  const since = periodStart(period);

  const fetchSales = since
    ? database.prepare(
        `SELECT id, items_json, total, payment_method, created_at
           FROM sales
          WHERE merchant_id = ? AND datetime(created_at) >= datetime(?)`,
      )
    : database.prepare(
        `SELECT id, items_json, total, payment_method, created_at
           FROM sales WHERE merchant_id = ?`,
      );
  const sales = (
    since ? fetchSales.all(merchantId, since) : fetchSales.all(merchantId)
  ) as SaleRow[];

  const fetchExpenses = since
    ? database.prepare(
        `SELECT id, category, description, amount, created_at
           FROM expenses
          WHERE merchant_id = ? AND datetime(created_at) >= datetime(?)`,
      )
    : database.prepare(
        `SELECT id, category, description, amount, created_at
           FROM expenses WHERE merchant_id = ?`,
      );
  const expenses = (
    since
      ? fetchExpenses.all(merchantId, since)
      : fetchExpenses.all(merchantId)
  ) as ExpenseRow[];

  const products = database
    .prepare(
      `SELECT id, cost_price, stock
         FROM products WHERE merchant_id = ?`,
    )
    .all(merchantId) as ProductRow[];
  const productById = new Map(products.map((p) => [p.id, p]));

  const totalRevenue = sales.reduce((s, r) => s + r.total, 0);
  let totalCOGS = 0;
  for (const sale of sales) {
    let items: SaleItem[] = [];
    try {
      items = JSON.parse(sale.items_json) as SaleItem[];
    } catch {
      continue;
    }
    for (const it of items) {
      const product = productById.get(it.productId);
      const costPrice =
        typeof product?.cost_price === 'number'
          ? product.cost_price
          : it.price * 0.7;
      totalCOGS += costPrice * it.quantity;
    }
  }
  const grossProfit = totalRevenue - totalCOGS;
  const grossMarginPct = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;

  const expensesByCategory = new Map<string, number>();
  for (const e of expenses) {
    expensesByCategory.set(
      e.category,
      (expensesByCategory.get(e.category) ?? 0) + e.amount,
    );
  }
  const totalExpenses = expenses.reduce((s, e) => s + e.amount, 0);
  const netProfit = grossProfit - totalExpenses;
  const netMarginPct = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;

  return res.json({
    period,
    rangeStart: since,
    totalRevenue: Number(totalRevenue.toFixed(2)),
    totalCOGS: Number(totalCOGS.toFixed(2)),
    grossProfit: Number(grossProfit.toFixed(2)),
    grossMarginPct: Number(grossMarginPct.toFixed(2)),
    totalExpenses: Number(totalExpenses.toFixed(2)),
    expensesByCategory: [...expensesByCategory.entries()].map(
      ([category, amount]) => ({
        category,
        amount: Number(amount.toFixed(2)),
      }),
    ),
    netProfit: Number(netProfit.toFixed(2)),
    netMarginPct: Number(netMarginPct.toFixed(2)),
    saleCount: sales.length,
    expenseCount: expenses.length,
  });
});
