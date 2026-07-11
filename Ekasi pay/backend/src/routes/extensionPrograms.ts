import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import { getDb } from '../db.js';
import {
  calcStokvelLoanInterest,
  toExpiryItem,
  toFoodSafetyAlert,
  toInsurance,
  toLayby,
  toLoadShedding,
  toPriceComparison,
  toStockMovement,
  toStokvel,
  toStokvelContribution,
  toStokvelLoan,
  toVoiceNote,
} from '../extraMappers.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { ensureMerchantId, requireMerchantId } from '../services/merchant.js';
import { getLoadSheddingSlots } from '../services/loadShedding.js';

export const extensionProgramsRouter = Router();

/* --- Load shedding (shared read) --- */
extensionProgramsRouter.get('/loadshedding', requireAuth, async (_req, res) => {
  const database = getDb();
  const rows = await getLoadSheddingSlots(database);
  return res.json({ slots: rows.map(toLoadShedding) });
});

/* --- Stokvel --- */
extensionProgramsRouter.get('/stokvel', requireAuth, (req, res) => {
  let merchantId: string;
  try {
    merchantId = ensureMerchantId(req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const database = getDb();
  const rows = database
    .prepare(
      'SELECT * FROM stokvel_groups WHERE merchant_id = ? ORDER BY created_at DESC',
    )
    .all(merchantId) as {
    id: string;
    merchant_id: string;
    name: string;
    members_json: string;
    target_amount: number;
    current_amount: number;
    frequency: string;
    next_payout_date: string;
    created_at: string;
  }[];
  const groups = rows.map(toStokvel);
  const loans = database
    .prepare(
      `SELECT l.* FROM stokvel_loans l
         INNER JOIN stokvel_groups g ON g.id = l.stokvel_id
        WHERE g.merchant_id = ?
        ORDER BY datetime(l.created_at) DESC`,
    )
    .all(merchantId) as Parameters<typeof toStokvelLoan>[0][];
  const loansByGroup = new Map<string, ReturnType<typeof toStokvelLoan>[]>();
  for (const row of loans) {
    const loan = toStokvelLoan(row);
    const list = loansByGroup.get(loan.stokvelId) ?? [];
    list.push(loan);
    loansByGroup.set(loan.stokvelId, list);
  }
  const contribs = database
    .prepare(
      `SELECT c.* FROM stokvel_contributions c
         INNER JOIN stokvel_groups g ON g.id = c.stokvel_id
        WHERE g.merchant_id = ?
        ORDER BY c.period_month DESC, datetime(c.created_at) DESC`,
    )
    .all(merchantId) as Parameters<typeof toStokvelContribution>[0][];
  const contribByGroup = new Map<
    string,
    ReturnType<typeof toStokvelContribution>[]
  >();
  for (const row of contribs) {
    const c = toStokvelContribution(row);
    const list = contribByGroup.get(c.stokvelId) ?? [];
    list.push(c);
    contribByGroup.set(c.stokvelId, list);
  }
  return res.json({
    groups: groups.map((g) => ({
      ...g,
      loans: loansByGroup.get(g.id) ?? [],
      contributions: contribByGroup.get(g.id) ?? [],
    })),
  });
});

const stokvelBody = z.object({
  name: z.string().min(1),
  members: z
    .array(
      z.object({
        name: z.string(),
        phone: z.string(),
        contributed: z.coerce.number().nonnegative(),
      })
    )
    .default([]),
  targetAmount: z.coerce.number().positive(),
  currentAmount: z.coerce.number().nonnegative(),
  frequency: z.enum(['weekly', 'monthly']),
  nextPayoutDate: z.string().min(1),
});

extensionProgramsRouter.post('/stokvel', requireAuth, (req, res) => {
  let merchantId: string;
  try {
    merchantId = ensureMerchantId(req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const parsed = stokvelBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const id = randomUUID();
  const now = new Date().toISOString();
  const database = getDb();
  const b = parsed.data;
  database
    .prepare(
      `INSERT INTO stokvel_groups (id, merchant_id, name, members_json, target_amount, current_amount, frequency, next_payout_date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      merchantId,
      b.name,
      JSON.stringify(b.members),
      b.targetAmount,
      b.currentAmount,
      b.frequency,
      b.nextPayoutDate,
      now
    );
  const row = database.prepare('SELECT * FROM stokvel_groups WHERE id = ?').get(id) as {
    id: string;
    merchant_id: string;
    name: string;
    members_json: string;
    target_amount: number;
    current_amount: number;
    frequency: string;
    next_payout_date: string;
    created_at: string;
  };
  return res.status(201).json({ group: toStokvel(row) });
});

const stokvelMembersBody = z.object({
  members: z.array(
    z.object({
      name: z.string().min(1),
      phone: z
        .string()
        .min(9)
        .max(20)
        .transform((v) => v.replace(/\s+/g, '')),
      contributed: z.coerce.number().nonnegative().default(0),
    }),
  ),
});

/**
 * Replace the members list on a stokvel group. We replace rather than merge so
 * the UI can drive a single source of truth in the manage-members modal.
 */
extensionProgramsRouter.patch(
  '/stokvel/:id/members',
  requireAuth,
  (req, res) => {
    let merchantId: string;
    try {
      merchantId = ensureMerchantId(req.auth!.userId);
    } catch {
      return res.status(403).json({ error: 'Merchant profile required' });
    }
    const parsed = stokvelMembersBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const database = getDb();
    const row = database
      .prepare(
        'SELECT * FROM stokvel_groups WHERE id = ? AND merchant_id = ?',
      )
      .get(req.params.id, merchantId) as
      | {
          id: string;
          merchant_id: string;
          name: string;
          members_json: string;
          target_amount: number;
          current_amount: number;
          frequency: string;
          next_payout_date: string;
          created_at: string;
        }
      | undefined;
    if (!row) return res.status(404).json({ error: 'Stokvel not found' });
    const total = parsed.data.members.reduce(
      (s, m) => s + Number(m.contributed || 0),
      0,
    );
    database
      .prepare(
        `UPDATE stokvel_groups
            SET members_json = ?, current_amount = ?
          WHERE id = ?`,
      )
      .run(
        JSON.stringify(parsed.data.members),
        Math.max(total, row.current_amount),
        row.id,
      );
    const fresh = database
      .prepare('SELECT * FROM stokvel_groups WHERE id = ?')
      .get(row.id) as typeof row;
    return res.json({ group: toStokvel(fresh) });
  },
);

const STOKVEL_INTEREST_TIERS = [10, 20, 30, 40, 50] as const;

const stokvelLoanBody = z.object({
  lenderName: z.string().trim().min(1),
  lenderPhone: z
    .string()
    .min(9)
    .max(20)
    .transform((v) => v.replace(/\s+/g, '')),
  borrowerName: z.string().trim().min(1),
  borrowerPhone: z
    .string()
    .min(9)
    .max(20)
    .transform((v) => v.replace(/\s+/g, '')),
  amount: z.coerce.number().positive(),
  interestRatePercent: z.coerce
    .number()
    .refine((v) => (STOKVEL_INTEREST_TIERS as readonly number[]).includes(v), {
      message: 'Interest must be 10, 20, 30, 40, or 50 percent per R100',
    }),
  fromPool: z.boolean().default(false),
  notes: z.string().trim().max(500).optional(),
});

extensionProgramsRouter.post('/stokvel/:id/loans', requireAuth, (req, res) => {
  let merchantId: string;
  try {
    merchantId = ensureMerchantId(req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const parsed = stokvelLoanBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const database = getDb();
  const group = database
    .prepare(
      'SELECT id, current_amount FROM stokvel_groups WHERE id = ? AND merchant_id = ?',
    )
    .get(req.params.id, merchantId) as
    | { id: string; current_amount: number }
    | undefined;
  if (!group) return res.status(404).json({ error: 'Stokvel not found' });
  const b = parsed.data;
  if (b.fromPool && group.current_amount < b.amount) {
    return res.status(400).json({
      error: `Pool only has R${Number(group.current_amount).toFixed(2)} — not enough to loan R${b.amount.toFixed(2)}.`,
    });
  }
  const { interestAmount, totalDue } = calcStokvelLoanInterest(
    b.amount,
    b.interestRatePercent,
  );
  const id = randomUUID();
  const now = new Date().toISOString();
  const tx = database.transaction(() => {
    database
      .prepare(
        `INSERT INTO stokvel_loans
          (id, stokvel_id, lender_name, lender_phone, borrower_name, borrower_phone,
           amount, interest_rate_percent, interest_amount, total_due, from_pool,
           status, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        id,
        group.id,
        b.lenderName,
        b.lenderPhone,
        b.borrowerName,
        b.borrowerPhone,
        b.amount,
        b.interestRatePercent,
        interestAmount,
        totalDue,
        b.fromPool ? 1 : 0,
        b.notes ?? null,
        now,
      );
    if (b.fromPool) {
      database
        .prepare(
          `UPDATE stokvel_groups SET current_amount = current_amount - ? WHERE id = ?`,
        )
        .run(b.amount, group.id);
    }
  });
  tx();
  const loan = database
    .prepare('SELECT * FROM stokvel_loans WHERE id = ?')
    .get(id) as Parameters<typeof toStokvelLoan>[0];
  const freshGroup = database
    .prepare('SELECT * FROM stokvel_groups WHERE id = ?')
    .get(group.id) as Parameters<typeof toStokvel>[0];
  return res.status(201).json({
    loan: toStokvelLoan(loan),
    group: toStokvel(freshGroup),
  });
});

extensionProgramsRouter.patch(
  '/stokvel/:id/loans/:loanId/repay',
  requireAuth,
  (req, res) => {
    let merchantId: string;
    try {
      merchantId = ensureMerchantId(req.auth!.userId);
    } catch {
      return res.status(403).json({ error: 'Merchant profile required' });
    }
    const database = getDb();
    const group = database
      .prepare(
        'SELECT id FROM stokvel_groups WHERE id = ? AND merchant_id = ?',
      )
      .get(req.params.id, merchantId) as { id: string } | undefined;
    if (!group) return res.status(404).json({ error: 'Stokvel not found' });
    const loan = database
      .prepare(
        'SELECT * FROM stokvel_loans WHERE id = ? AND stokvel_id = ?',
      )
      .get(req.params.loanId, req.params.id) as
      | (Parameters<typeof toStokvelLoan>[0] & { from_pool: number })
      | undefined;
    if (!loan) return res.status(404).json({ error: 'Loan not found' });
    if (loan.status === 'repaid') {
      return res.status(409).json({ error: 'Loan is already repaid' });
    }
    const now = new Date().toISOString();
    const tx = database.transaction(() => {
      database
        .prepare(
          `UPDATE stokvel_loans SET status = 'repaid', repaid_at = ? WHERE id = ?`,
        )
        .run(now, loan.id);
      if (loan.from_pool) {
        database
          .prepare(
            `UPDATE stokvel_groups SET current_amount = current_amount + ? WHERE id = ?`,
          )
          .run(loan.amount, group.id);
      }
    });
    tx();
    const freshLoan = database
      .prepare('SELECT * FROM stokvel_loans WHERE id = ?')
      .get(loan.id) as Parameters<typeof toStokvelLoan>[0];
    const freshGroup = database
      .prepare('SELECT * FROM stokvel_groups WHERE id = ?')
      .get(group.id) as Parameters<typeof toStokvel>[0];
    return res.json({
      loan: toStokvelLoan(freshLoan),
      group: toStokvel(freshGroup),
    });
  },
);

const periodMonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM for the contribution month');

const stokvelContributionBody = z.object({
  memberPhone: z
    .string()
    .min(9)
    .max(20)
    .transform((v) => v.replace(/\s+/g, '')),
  amount: z.coerce.number().positive(),
  periodMonth: periodMonthSchema,
  notes: z.string().trim().max(500).optional(),
});

extensionProgramsRouter.post(
  '/stokvel/:id/contributions',
  requireAuth,
  (req, res) => {
    let merchantId: string;
    try {
      merchantId = ensureMerchantId(req.auth!.userId);
    } catch {
      return res.status(403).json({ error: 'Merchant profile required' });
    }
    const parsed = stokvelContributionBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const database = getDb();
    const group = database
      .prepare(
        `SELECT id, members_json, current_amount FROM stokvel_groups
          WHERE id = ? AND merchant_id = ?`,
      )
      .get(req.params.id, merchantId) as
      | { id: string; members_json: string; current_amount: number }
      | undefined;
    if (!group) return res.status(404).json({ error: 'Stokvel not found' });
    const members = JSON.parse(group.members_json) as {
      name: string;
      phone: string;
      contributed: number;
    }[];
    const member = members.find((m) => m.phone === parsed.data.memberPhone);
    if (!member) {
      return res.status(400).json({
        error: 'Member not found in this stokvel. Add them under Members first.',
      });
    }
    const existing = database
      .prepare(
        `SELECT id, amount FROM stokvel_contributions
          WHERE stokvel_id = ? AND member_phone = ? AND period_month = ?`,
      )
      .get(group.id, member.phone, parsed.data.periodMonth) as
      | { id: string; amount: number }
      | undefined;
    const now = new Date().toISOString();
    const newAmount = parsed.data.amount;
    const delta = existing ? newAmount - Number(existing.amount) : newAmount;
    const id = existing?.id ?? randomUUID();
    const tx = database.transaction(() => {
      if (existing) {
        database
          .prepare(
            `UPDATE stokvel_contributions
                SET amount = ?, notes = ?, member_name = ?
              WHERE id = ?`,
          )
          .run(newAmount, parsed.data.notes ?? null, member.name, existing.id);
      } else {
        database
          .prepare(
            `INSERT INTO stokvel_contributions
              (id, stokvel_id, member_name, member_phone, amount, period_month, notes, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            group.id,
            member.name,
            member.phone,
            newAmount,
            parsed.data.periodMonth,
            parsed.data.notes ?? null,
            now,
          );
      }
      const nextMembers = members.map((m) =>
        m.phone === member.phone
          ? {
              ...m,
              contributed: Number(
                (Number(m.contributed || 0) + delta).toFixed(2),
              ),
            }
          : m,
      );
      const nextPool = Math.max(0, Number(group.current_amount) + delta);
      database
        .prepare(
          `UPDATE stokvel_groups
              SET members_json = ?, current_amount = ?
            WHERE id = ?`,
        )
        .run(JSON.stringify(nextMembers), nextPool, group.id);
    });
    tx();
    const contrib = database
      .prepare('SELECT * FROM stokvel_contributions WHERE id = ?')
      .get(id) as Parameters<typeof toStokvelContribution>[0];
    const freshGroup = database
      .prepare('SELECT * FROM stokvel_groups WHERE id = ?')
      .get(group.id) as Parameters<typeof toStokvel>[0];
    return res.status(existing ? 200 : 201).json({
      contribution: toStokvelContribution(contrib),
      group: toStokvel(freshGroup),
    });
  },
);

/* --- Layby --- */
extensionProgramsRouter.get('/layby', requireAuth, (req, res) => {
  let merchantId: string;
  try {
    merchantId = requireMerchantId(req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const database = getDb();
  const rows = database
    .prepare(
      `SELECT * FROM layby_orders WHERE merchant_id = ? ORDER BY datetime(created_at) DESC`
    )
    .all(merchantId) as {
    id: string;
    merchant_id: string;
    customer_name: string;
    customer_phone: string;
    item_name: string;
    total_price: number;
    amount_paid: number;
    installments_json: string;
    status: string;
    created_at: string;
  }[];
  return res.json({ orders: rows.map(toLayby) });
});

const laybyBody = z.object({
  customerName: z.string().min(1),
  customerPhone: z.string().min(9).max(20),
  itemName: z.string().min(1),
  totalPrice: z.coerce.number().positive(),
  amountPaid: z.coerce.number().nonnegative(),
  installments: z
    .array(
      z.object({
        amount: z.coerce.number().nonnegative(),
        date: z.string(),
      })
    )
    .default([]),
  status: z.enum(['active', 'completed', 'cancelled']).default('active'),
});

extensionProgramsRouter.post('/layby', requireAuth, (req, res) => {
  let merchantId: string;
  try {
    merchantId = requireMerchantId(req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const parsed = laybyBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const id = randomUUID();
  const now = new Date().toISOString();
  const database = getDb();
  const b = parsed.data;
  database
    .prepare(
      `INSERT INTO layby_orders (id, merchant_id, customer_name, customer_phone, item_name, total_price, amount_paid, installments_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      merchantId,
      b.customerName,
      b.customerPhone.replace(/\s+/g, ''),
      b.itemName,
      b.totalPrice,
      b.amountPaid,
      JSON.stringify(b.installments),
      b.status,
      now
    );
  const row = database.prepare('SELECT * FROM layby_orders WHERE id = ?').get(id) as {
    id: string;
    merchant_id: string;
    customer_name: string;
    customer_phone: string;
    item_name: string;
    total_price: number;
    amount_paid: number;
    installments_json: string;
    status: string;
    created_at: string;
  };
  return res.status(201).json({ order: toLayby(row) });
});

const laybyPaymentBody = z.object({
  amount: z.coerce.number().positive(),
  date: z.string().min(1).optional(),
});

type LaybyRow = {
  id: string;
  merchant_id: string;
  customer_name: string;
  customer_phone: string;
  item_name: string;
  total_price: number;
  amount_paid: number;
  installments_json: string;
  status: string;
  created_at: string;
};

/** Record an installment payment; auto-completes the layby when the balance hits zero. */
extensionProgramsRouter.post(
  '/layby/:id/payments',
  requireAuth,
  (req, res) => {
    let merchantId: string;
    try {
      merchantId = requireMerchantId(req.auth!.userId);
    } catch {
      return res.status(403).json({ error: 'Merchant profile required' });
    }
    const parsed = laybyPaymentBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const database = getDb();
    const row = database
      .prepare(
        'SELECT * FROM layby_orders WHERE id = ? AND merchant_id = ?',
      )
      .get(req.params.id, merchantId) as LaybyRow | undefined;
    if (!row) return res.status(404).json({ error: 'Layby not found' });
    if (row.status !== 'active') {
      return res
        .status(409)
        .json({ error: `Layby is ${row.status} — payments closed.` });
    }
    const outstanding = Number((row.total_price - row.amount_paid).toFixed(2));
    if (outstanding <= 0) {
      return res
        .status(409)
        .json({ error: 'Layby already paid in full.' });
    }
    const applied = Math.min(parsed.data.amount, outstanding);
    let installments: { amount: number; date: string }[] = [];
    try {
      installments = JSON.parse(row.installments_json || '[]');
    } catch {
      installments = [];
    }
    installments.push({
      amount: applied,
      date: parsed.data.date ?? new Date().toISOString(),
    });
    const newPaid = Number((row.amount_paid + applied).toFixed(2));
    const newStatus =
      newPaid >= row.total_price - 0.005 ? 'completed' : 'active';
    database
      .prepare(
        `UPDATE layby_orders
            SET amount_paid = ?, installments_json = ?, status = ?
          WHERE id = ?`,
      )
      .run(newPaid, JSON.stringify(installments), newStatus, row.id);
    const fresh = database
      .prepare('SELECT * FROM layby_orders WHERE id = ?')
      .get(row.id) as LaybyRow;
    return res.json({
      order: toLayby(fresh),
      applied,
      outstanding: Number((fresh.total_price - fresh.amount_paid).toFixed(2)),
    });
  },
);

/* --- Price comparisons --- */
extensionProgramsRouter.get('/price-comparisons', requireAuth, (req, res) => {
  let merchantId: string;
  try {
    merchantId = requireMerchantId(req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const q = typeof req.query.merchantId === 'string' ? req.query.merchantId : '';
  if (q && q !== merchantId) return res.status(403).json({ error: 'Forbidden' });
  const database = getDb();
  const rows = database
    .prepare(
      'SELECT * FROM price_comparisons WHERE merchant_id = ? ORDER BY last_updated DESC'
    )
    .all(merchantId) as {
    id: string;
    merchant_id: string;
    product_name: string;
    my_price: number;
    avg_area_price: number;
    lowest_area_price: number;
    highest_area_price: number;
    competitors: number;
    last_updated: string;
  }[];
  return res.json({ comparisons: rows.map(toPriceComparison) });
});

const priceBody = z.object({
  productName: z.string().min(1),
  myPrice: z.coerce.number().nonnegative(),
  avgAreaPrice: z.coerce.number().nonnegative(),
  lowestAreaPrice: z.coerce.number().nonnegative(),
  highestAreaPrice: z.coerce.number().nonnegative(),
  competitors: z.coerce.number().int().nonnegative(),
});

extensionProgramsRouter.post('/price-comparisons', requireAuth, (req, res) => {
  let merchantId: string;
  try {
    merchantId = requireMerchantId(req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const parsed = priceBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const id = randomUUID();
  const now = new Date().toISOString();
  const database = getDb();
  const b = parsed.data;
  database
    .prepare(
      `INSERT INTO price_comparisons (id, merchant_id, product_name, my_price, avg_area_price, lowest_area_price, highest_area_price, competitors, last_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      merchantId,
      b.productName,
      b.myPrice,
      b.avgAreaPrice,
      b.lowestAreaPrice,
      b.highestAreaPrice,
      b.competitors,
      now
    );
  const row = database.prepare('SELECT * FROM price_comparisons WHERE id = ?').get(id) as {
    id: string;
    merchant_id: string;
    product_name: string;
    my_price: number;
    avg_area_price: number;
    lowest_area_price: number;
    highest_area_price: number;
    competitors: number;
    last_updated: string;
  };
  return res.status(201).json({ comparison: toPriceComparison(row) });
});

/* --- Insurance --- */
extensionProgramsRouter.get('/insurance', requireAuth, (req, res) => {
  let merchantId: string;
  try {
    merchantId = ensureMerchantId(req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const database = getDb();
  const rows = database
    .prepare('SELECT * FROM insurance_policies WHERE merchant_id = ?')
    .all(merchantId) as {
    id: string;
    merchant_id: string;
    provider: string;
    type: string;
    coverage_amount: number;
    monthly_premium: number;
    status: string;
    next_payment_date: string;
  }[];
  return res.json({ policies: rows.map(toInsurance) });
});

const insBody = z.object({
  provider: z.string().min(1),
  type: z.enum(['stock', 'fire', 'theft']),
  coverageAmount: z.coerce.number().positive(),
  monthlyPremium: z.coerce.number().positive(),
  status: z.enum(['active', 'pending', 'cancelled']).default('pending'),
  nextPaymentDate: z.string().min(1),
});

extensionProgramsRouter.post('/insurance', requireAuth, (req, res) => {
  let merchantId: string;
  try {
    merchantId = ensureMerchantId(req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const parsed = insBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const id = randomUUID();
  const database = getDb();
  const b = parsed.data;
  database
    .prepare(
      `INSERT INTO insurance_policies (id, merchant_id, provider, type, coverage_amount, monthly_premium, status, next_payment_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, merchantId, b.provider, b.type, b.coverageAmount, b.monthlyPremium, b.status, b.nextPaymentDate);
  const row = database.prepare('SELECT * FROM insurance_policies WHERE id = ?').get(id) as {
    id: string;
    merchant_id: string;
    provider: string;
    type: string;
    coverage_amount: number;
    monthly_premium: number;
    status: string;
    next_payment_date: string;
  };
  return res.status(201).json({ policy: toInsurance(row) });
});

const claimBody = z.object({
  type: z.enum(['stock', 'fire', 'theft']),
  description: z.string().min(3).max(2000),
  claimedAmount: z.coerce.number().positive(),
});

type ClaimRow = {
  id: string;
  policy_id: string;
  merchant_id: string;
  type: string;
  description: string;
  claimed_amount: number;
  status: string;
  created_at: string;
  reviewed_at?: string | null;
  reviewed_by?: string | null;
  admin_note?: string | null;
};

function toInsuranceClaim(row: ClaimRow) {
  return {
    id: row.id,
    policyId: row.policy_id,
    merchantId: row.merchant_id,
    type: row.type,
    description: row.description,
    claimedAmount: row.claimed_amount,
    status: row.status,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at ?? undefined,
    adminNote: row.admin_note ?? undefined,
  };
}

extensionProgramsRouter.get(
  '/insurance/:id/claims',
  requireAuth,
  (req, res) => {
    let merchantId: string;
    try {
      merchantId = ensureMerchantId(req.auth!.userId);
    } catch {
      return res.status(403).json({ error: 'Merchant profile required' });
    }
    const database = getDb();
    const policy = database
      .prepare(
        'SELECT id FROM insurance_policies WHERE id = ? AND merchant_id = ?',
      )
      .get(req.params.id, merchantId) as { id: string } | undefined;
    if (!policy) return res.status(404).json({ error: 'Policy not found' });
    const rows = database
      .prepare(
        `SELECT * FROM insurance_claims WHERE policy_id = ? ORDER BY datetime(created_at) DESC`,
      )
      .all(policy.id) as ClaimRow[];
    return res.json({ claims: rows.map(toInsuranceClaim) });
  },
);

extensionProgramsRouter.post(
  '/insurance/:id/claims',
  requireAuth,
  (req, res) => {
    let merchantId: string;
    try {
      merchantId = ensureMerchantId(req.auth!.userId);
    } catch {
      return res.status(403).json({ error: 'Merchant profile required' });
    }
    const parsed = claimBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const database = getDb();
    const policy = database
      .prepare(
        `SELECT id, status, coverage_amount FROM insurance_policies
         WHERE id = ? AND merchant_id = ?`,
      )
      .get(req.params.id, merchantId) as
      | { id: string; status: string; coverage_amount: number }
      | undefined;
    if (!policy) return res.status(404).json({ error: 'Policy not found' });
    if (policy.status !== 'active') {
      return res
        .status(409)
        .json({ error: `Policy is ${policy.status} — claims paused.` });
    }
    if (parsed.data.claimedAmount > policy.coverage_amount) {
      return res.status(400).json({
        error: `Claimed amount exceeds coverage (R${policy.coverage_amount.toFixed(2)}).`,
      });
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO insurance_claims
           (id, policy_id, merchant_id, type, description, claimed_amount, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'submitted', ?)`,
      )
      .run(
        id,
        policy.id,
        merchantId,
        parsed.data.type,
        parsed.data.description.trim(),
        parsed.data.claimedAmount,
        now,
      );
    const row = database
      .prepare('SELECT * FROM insurance_claims WHERE id = ?')
      .get(id) as ClaimRow;
    return res.status(201).json({ claim: toInsuranceClaim(row) });
  },
);

/* --- Voice notes --- */
extensionProgramsRouter.get('/voice-notes', requireAuth, (req, res) => {
  let merchantId: string;
  try {
    merchantId = requireMerchantId(req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const database = getDb();
  const rows = database
    .prepare(
      `SELECT * FROM voice_notes WHERE merchant_id = ? ORDER BY datetime(created_at) DESC`
    )
    .all(merchantId) as {
    id: string;
    merchant_id: string;
    title: string;
    transcript: string;
    duration: number;
    category: string;
    created_at: string;
  }[];
  return res.json({ notes: rows.map(toVoiceNote) });
});

const voiceBody = z.object({
  title: z.string().min(1),
  transcript: z.string().default(''),
  duration: z.coerce.number().nonnegative().default(0),
  category: z.enum(['reminder', 'debt', 'order', 'general']).default('general'),
});

extensionProgramsRouter.post('/voice-notes', requireAuth, (req, res) => {
  let merchantId: string;
  try {
    merchantId = requireMerchantId(req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const parsed = voiceBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const id = randomUUID();
  const now = new Date().toISOString();
  const database = getDb();
  const b = parsed.data;
  database
    .prepare(
      `INSERT INTO voice_notes (id, merchant_id, title, transcript, duration, category, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, merchantId, b.title, b.transcript, b.duration, b.category, now);
  const row = database.prepare('SELECT * FROM voice_notes WHERE id = ?').get(id) as {
    id: string;
    merchant_id: string;
    title: string;
    transcript: string;
    duration: number;
    category: string;
    created_at: string;
  };
  return res.status(201).json({ note: toVoiceNote(row) });
});

extensionProgramsRouter.delete('/voice-notes/:id', requireAuth, (req, res) => {
  let merchantId: string;
  try {
    merchantId = requireMerchantId(req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const database = getDb();
  const r = database
    .prepare('DELETE FROM voice_notes WHERE id = ? AND merchant_id = ?')
    .run(req.params.id, merchantId);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  return res.json({ ok: true });
});

/* --- Expiry tracking --- */
extensionProgramsRouter.get('/expiry-items', requireAuth, (req, res) => {
  let merchantId: string;
  try {
    merchantId = requireMerchantId(req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const database = getDb();
  const rows = database
    .prepare(
      'SELECT * FROM expiry_items WHERE merchant_id = ? ORDER BY expiry_date'
    )
    .all(merchantId) as {
    id: string;
    merchant_id: string;
    product_name: string;
    category: string;
    batch_number: string;
    expiry_date: string;
    quantity: number;
    supplier_id: string;
    status: string;
  }[];
  return res.json({ items: rows.map(toExpiryItem) });
});

const expiryBody = z.object({
  productName: z.string().min(1),
  category: z.string().min(1),
  batchNumber: z.string().min(1),
  expiryDate: z.string().min(1),
  quantity: z.coerce.number().int().nonnegative(),
  supplierId: z.string().min(1),
  status: z.enum(['safe', 'expiring-soon', 'expired']).default('safe'),
});

extensionProgramsRouter.post('/expiry-items', requireAuth, (req, res) => {
  let merchantId: string;
  try {
    merchantId = requireMerchantId(req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const parsed = expiryBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const id = randomUUID();
  const database = getDb();
  const b = parsed.data;
  database
    .prepare(
      `INSERT INTO expiry_items (id, merchant_id, product_name, category, batch_number, expiry_date, quantity, supplier_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      merchantId,
      b.productName,
      b.category,
      b.batchNumber,
      b.expiryDate,
      b.quantity,
      b.supplierId,
      b.status
    );
  const row = database.prepare('SELECT * FROM expiry_items WHERE id = ?').get(id) as {
    id: string;
    merchant_id: string;
    product_name: string;
    category: string;
    batch_number: string;
    expiry_date: string;
    quantity: number;
    supplier_id: string;
    status: string;
  };
  return res.status(201).json({ item: toExpiryItem(row) });
});

/* --- Food safety alerts --- */
extensionProgramsRouter.get('/food-safety-alerts', requireAuth, (req, res) => {
  let merchantId: string;
  try {
    merchantId = requireMerchantId(req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const database = getDb();
  const rows = database
    .prepare(
      `SELECT * FROM food_safety_alerts
       WHERE merchant_id IS NULL OR merchant_id = ?
       ORDER BY datetime(created_at) DESC LIMIT 100`
    )
    .all(merchantId) as {
    id: string;
    merchant_id: string | null;
    type: string;
    title: string;
    description: string;
    severity: string;
    created_at: string;
    is_read: number;
  }[];
  return res.json({ alerts: rows.map(toFoodSafetyAlert) });
});

const alertBody = z.object({
  type: z.enum(['recall', 'expiry', 'supplier', 'inspection']),
  title: z.string().min(1),
  description: z.string().min(1),
  severity: z.enum(['critical', 'warning', 'info']),
  merchantScope: z.boolean().default(true),
});

extensionProgramsRouter.post('/food-safety-alerts', requireAuth, (req, res) => {
  let merchantId: string;
  try {
    merchantId = requireMerchantId(req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const parsed = alertBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const id = randomUUID();
  const now = new Date().toISOString();
  const database = getDb();
  const b = parsed.data;
  const midScope = b.merchantScope ? merchantId : null;
  database
    .prepare(
      `INSERT INTO food_safety_alerts (id, merchant_id, type, title, description, severity, created_at, is_read)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
    )
    .run(id, midScope, b.type, b.title, b.description, b.severity, now);
  const row = database.prepare('SELECT * FROM food_safety_alerts WHERE id = ?').get(id) as {
    id: string;
    merchant_id: string | null;
    type: string;
    title: string;
    description: string;
    severity: string;
    created_at: string;
    is_read: number;
  };
  return res.status(201).json({ alert: toFoodSafetyAlert(row) });
});

extensionProgramsRouter.patch('/food-safety-alerts/:id/read', requireAuth, (req, res) => {
  const database = getDb();
  database
    .prepare('UPDATE food_safety_alerts SET is_read = 1 WHERE id = ?')
    .run(req.params.id);
  return res.json({ ok: true });
});

/* --- Stock movements --- */
extensionProgramsRouter.get('/stock-movements', requireAuth, (req, res) => {
  let merchantId: string;
  try {
    merchantId = requireMerchantId(req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const database = getDb();
  const rows = database
    .prepare(
      `SELECT * FROM stock_movements WHERE merchant_id = ? ORDER BY datetime(created_at) DESC LIMIT 500`
    )
    .all(merchantId) as {
    id: string;
    merchant_id: string;
    product_id: string;
    product_name: string;
    type: string;
    quantity: number;
    reason: string;
    cost_price_at_time: number | null;
    reference: string | null;
    notes: string | null;
    created_at: string;
  }[];
  return res.json({ movements: rows.map(toStockMovement) });
});

const stockMoveBody = z.object({
  productId: z.string().min(1),
  productName: z.string().min(1),
  type: z.enum(['in', 'out', 'adjustment']),
  quantity: z.coerce.number().int().positive(),
  reason: z.enum([
    'sale',
    'restock',
    'damage',
    'expired',
    'theft',
    'manual',
    'initial',
  ]),
  costPriceAtTime: z.coerce.number().optional(),
  reference: z.string().optional(),
  notes: z.string().optional(),
});

extensionProgramsRouter.post('/stock-movements', requireAuth, (req, res) => {
  let merchantId: string;
  try {
    merchantId = requireMerchantId(req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const parsed = stockMoveBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const id = randomUUID();
  const now = new Date().toISOString();
  const database = getDb();
  const b = parsed.data;
  database
    .prepare(
      `INSERT INTO stock_movements (id, merchant_id, product_id, product_name, type, quantity, reason, cost_price_at_time, reference, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      merchantId,
      b.productId,
      b.productName,
      b.type,
      b.quantity,
      b.reason,
      b.costPriceAtTime ?? null,
      b.reference ?? null,
      b.notes ?? null,
      now
    );
  const row = database.prepare('SELECT * FROM stock_movements WHERE id = ?').get(id) as {
    id: string;
    merchant_id: string;
    product_id: string;
    product_name: string;
    type: string;
    quantity: number;
    reason: string;
    cost_price_at_time: number | null;
    reference: string | null;
    notes: string | null;
    created_at: string;
  };
  return res.status(201).json({ movement: toStockMovement(row) });
});
