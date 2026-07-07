import { Router } from 'express';
import { z } from 'zod';

import { getPgPool } from '../dbPg.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireMerchantIdPg } from '../services/merchantPg.js';

export const analyticsRouterPg = Router();

type SaleItem = {
  productId: string;
  name: string;
  quantity: number;
  price: number;
  subtotal: number;
  costPrice?: number;
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
          `SELECT id, items_json, total, payment_method, created_at
             FROM sales
            WHERE merchant_id = $1 AND created_at >= $2`,
          [merchantId, since],
        )
      : await pool.query<SaleRow>(
          `SELECT id, items_json, total, payment_method, created_at
             FROM sales
            WHERE merchant_id = $1`,
          [merchantId],
        )
  ).rows;

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

analyticsRouterPg.get('/reports/income-statement', requireAuth, async (req, res) => {
  const period = periodSchema.parse(req.query.period);
  const pool = getPgPool();
  const merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
  const since = periodStart(period);

  const sales = (
    since
      ? await pool.query<SaleRow>(
          `SELECT id, items_json, total, payment_method, created_at
             FROM sales
            WHERE merchant_id = $1 AND created_at >= $2`,
          [merchantId, since],
        )
      : await pool.query<SaleRow>(
          `SELECT id, items_json, total, payment_method, created_at
             FROM sales
            WHERE merchant_id = $1`,
          [merchantId],
        )
  ).rows;

  const expenses = (
    since
      ? await pool.query<ExpenseRow>(
          `SELECT id, category, description, amount, created_at
             FROM expenses
            WHERE merchant_id = $1 AND created_at >= $2`,
          [merchantId, since],
        )
      : await pool.query<ExpenseRow>(
          `SELECT id, category, description, amount, created_at
             FROM expenses
            WHERE merchant_id = $1`,
          [merchantId],
        )
  ).rows;

  const products = (
    await pool.query<ProductRow>(
      `SELECT id, cost_price, stock FROM products WHERE merchant_id = $1`,
      [merchantId],
    )
  ).rows;
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
        typeof it.costPrice === 'number'
          ? it.costPrice
          : typeof product?.cost_price === 'number'
            ? product.cost_price
            : it.price * 0.7;
      totalCOGS += costPrice * it.quantity;
    }
  }
  const grossProfit = totalRevenue - totalCOGS;
  const grossMarginPct = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;

  const expensesByCategory = new Map<string, number>();
  for (const e of expenses) {
    expensesByCategory.set(e.category, (expensesByCategory.get(e.category) ?? 0) + e.amount);
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
    expensesByCategory: [...expensesByCategory.entries()].map(([category, amount]) => ({
      category,
      amount: Number(amount.toFixed(2)),
    })),
    netProfit: Number(netProfit.toFixed(2)),
    netMarginPct: Number(netMarginPct.toFixed(2)),
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
          `SELECT id, category, description, amount, created_at
             FROM expenses
            WHERE merchant_id = $1 AND created_at >= $2
            ORDER BY created_at DESC`,
          [merchantId, since],
        )
      : await pool.query<ExpenseRow>(
          `SELECT id, category, description, amount, created_at
             FROM expenses
            WHERE merchant_id = $1
            ORDER BY created_at DESC`,
          [merchantId],
        )
  ).rows;

  const expensesByCategory = new Map<string, number>();
  for (const e of expenses) {
    expensesByCategory.set(e.category, (expensesByCategory.get(e.category) ?? 0) + e.amount);
  }
  const totalExpenses = expenses.reduce((s, e) => s + e.amount, 0);

  return res.json({
    period,
    rangeStart: since,
    totalExpenses: Number(totalExpenses.toFixed(2)),
    expensesByCategory: [...expensesByCategory.entries()].map(([category, amount]) => ({
      category,
      amount: Number(amount.toFixed(2)),
    })),
    expenses: expenses.map((e) => ({
      id: e.id,
      category: e.category,
      description: e.description,
      amount: Number(e.amount.toFixed(2)),
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
    cost_price: number;
    price: number;
    stock: number;
    category: string;
    barcode: string | null;
  }>(
    `SELECT id, name, cost_price, price, stock, category, barcode
       FROM products
      WHERE merchant_id = $1
      ORDER BY lower(category), lower(name)`,
    [merchantId],
  );

  const items = rows.rows.map((p) => {
    const costValue = (p.cost_price ?? 0) * p.stock;
    const retailValue = p.price * p.stock;
    return {
      id: p.id,
      name: p.name,
      category: p.category,
      barcode: p.barcode ?? undefined,
      stock: p.stock,
      costPrice: Number((p.cost_price ?? 0).toFixed(2)),
      sellingPrice: Number(p.price.toFixed(2)),
      costValue: Number(costValue.toFixed(2)),
      retailValue: Number(retailValue.toFixed(2)),
      marginPerUnit: Number((p.price - (p.cost_price ?? 0)).toFixed(2)),
    };
  });

  const totalUnits = items.reduce((s, i) => s + i.stock, 0);
  const totalCostValue = items.reduce((s, i) => s + i.costValue, 0);
  const totalRetailValue = items.reduce((s, i) => s + i.retailValue, 0);
  const lowStockCount = items.filter((i) => i.stock > 0 && i.stock < 10).length;
  const outOfStockCount = items.filter((i) => i.stock === 0).length;

  return res.json({
    generatedAt: new Date().toISOString(),
    totalSkus: items.length,
    totalUnits,
    totalCostValue: Number(totalCostValue.toFixed(2)),
    totalRetailValue: Number(totalRetailValue.toFixed(2)),
    lowStockCount,
    outOfStockCount,
    items,
  });
});
