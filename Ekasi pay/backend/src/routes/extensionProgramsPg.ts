import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import { getPgPool } from '../dbPg.js';
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
  toStokvelLoan,
  toVoiceNote,
} from '../extraMappers.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { getLoadSheddingSlotsPg } from '../services/loadSheddingPg.js';
import {
  ensureMerchantIdPg,
  requireMerchantIdPg,
} from '../services/merchantPg.js';

export const extensionProgramsRouterPg = Router();

extensionProgramsRouterPg.get(
  '/loadshedding',
  requireAuth,
  async (_req, res) => {
    const pool = getPgPool();
    const rows = await getLoadSheddingSlotsPg(pool);
    return res.json({ slots: rows.map(toLoadShedding) });
  },
);

extensionProgramsRouterPg.get('/stokvel', requireAuth, async (req, res) => {
  const pool = getPgPool();
  let merchantId: string;
  try {
    merchantId = await ensureMerchantIdPg(pool, req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const r = await pool.query(
    `SELECT * FROM stokvel_groups WHERE merchant_id = $1 ORDER BY created_at DESC`,
    [merchantId],
  );
  const groups = r.rows.map(toStokvel);
  const ids = groups.map((g) => g.id);
  const loansByGroup = new Map<string, ReturnType<typeof toStokvelLoan>[]>();
  if (ids.length > 0) {
    const lq = await pool.query(
      `SELECT * FROM stokvel_loans
        WHERE stokvel_id = ANY($1::text[])
        ORDER BY created_at DESC`,
      [ids],
    );
    for (const row of lq.rows) {
      const loan = toStokvelLoan(row);
      const list = loansByGroup.get(loan.stokvelId) ?? [];
      list.push(loan);
      loansByGroup.set(loan.stokvelId, list);
    }
  }
  return res.json({
    groups: groups.map((g) => ({
      ...g,
      loans: loansByGroup.get(g.id) ?? [],
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
      }),
    )
    .default([]),
  targetAmount: z.coerce.number().positive(),
  currentAmount: z.coerce.number().nonnegative(),
  frequency: z.enum(['weekly', 'monthly']),
  nextPayoutDate: z.string().min(1),
});

extensionProgramsRouterPg.post('/stokvel', requireAuth, async (req, res) => {
  const pool = getPgPool();
  let merchantId: string;
  try {
    merchantId = await ensureMerchantIdPg(pool, req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const parsed = stokvelBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  const b = parsed.data;
  await pool.query(
    `INSERT INTO stokvel_groups
      (id, merchant_id, name, members_json, target_amount, current_amount, frequency, next_payout_date, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      merchantId,
      b.name,
      JSON.stringify(b.members),
      b.targetAmount,
      b.currentAmount,
      b.frequency,
      b.nextPayoutDate,
      now,
    ],
  );
  const rowQ = await pool.query(
    `SELECT * FROM stokvel_groups WHERE id = $1`,
    [id],
  );
  return res.status(201).json({ group: toStokvel(rowQ.rows[0]) });
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

extensionProgramsRouterPg.patch(
  '/stokvel/:id/members',
  requireAuth,
  async (req, res) => {
    const pool = getPgPool();
    let merchantId: string;
    try {
      merchantId = await ensureMerchantIdPg(pool, req.auth!.userId);
    } catch {
      return res.status(403).json({ error: 'Merchant profile required' });
    }
    const parsed = stokvelMembersBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const rowQ = await pool.query(
      `SELECT * FROM stokvel_groups WHERE id = $1 AND merchant_id = $2`,
      [req.params.id, merchantId],
    );
    const row = rowQ.rows[0];
    if (!row) return res.status(404).json({ error: 'Stokvel not found' });
    const total = parsed.data.members.reduce(
      (s, m) => s + Number(m.contributed || 0),
      0,
    );
    await pool.query(
      `UPDATE stokvel_groups SET members_json = $1, current_amount = $2 WHERE id = $3`,
      [
        JSON.stringify(parsed.data.members),
        Math.max(total, row.current_amount),
        row.id,
      ],
    );
    const freshQ = await pool.query(
      `SELECT * FROM stokvel_groups WHERE id = $1`,
      [row.id],
    );
    return res.json({ group: toStokvel(freshQ.rows[0]) });
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
  /** Percent charged on every R100 loaned (10 → R10 interest per R100). */
  interestRatePercent: z.coerce
    .number()
    .refine((v) => (STOKVEL_INTEREST_TIERS as readonly number[]).includes(v), {
      message: 'Interest must be 10, 20, 30, 40, or 50 percent per R100',
    }),
  fromPool: z.boolean().default(false),
  notes: z.string().trim().max(500).optional(),
});

extensionProgramsRouterPg.post(
  '/stokvel/:id/loans',
  requireAuth,
  async (req, res) => {
    const pool = getPgPool();
    let merchantId: string;
    try {
      merchantId = await ensureMerchantIdPg(pool, req.auth!.userId);
    } catch {
      return res.status(403).json({ error: 'Merchant profile required' });
    }
    const parsed = stokvelLoanBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const groupQ = await pool.query<{
      id: string;
      current_amount: number;
    }>(
      `SELECT id, current_amount FROM stokvel_groups WHERE id = $1 AND merchant_id = $2`,
      [req.params.id, merchantId],
    );
    const group = groupQ.rows[0];
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
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO stokvel_loans
          (id, stokvel_id, lender_name, lender_phone, borrower_name, borrower_phone,
           amount, interest_rate_percent, interest_amount, total_due, from_pool,
           status, notes, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active',$12,$13)`,
        [
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
          b.fromPool,
          b.notes ?? null,
          now,
        ],
      );
      if (b.fromPool) {
        await client.query(
          `UPDATE stokvel_groups
              SET current_amount = current_amount - $1
            WHERE id = $2`,
          [b.amount, group.id],
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    const loanQ = await pool.query(`SELECT * FROM stokvel_loans WHERE id = $1`, [
      id,
    ]);
    const groupFresh = await pool.query(
      `SELECT * FROM stokvel_groups WHERE id = $1`,
      [group.id],
    );
    return res.status(201).json({
      loan: toStokvelLoan(loanQ.rows[0]),
      group: toStokvel(groupFresh.rows[0]),
    });
  },
);

extensionProgramsRouterPg.patch(
  '/stokvel/:id/loans/:loanId/repay',
  requireAuth,
  async (req, res) => {
    const pool = getPgPool();
    let merchantId: string;
    try {
      merchantId = await ensureMerchantIdPg(pool, req.auth!.userId);
    } catch {
      return res.status(403).json({ error: 'Merchant profile required' });
    }
    const groupQ = await pool.query<{ id: string }>(
      `SELECT id FROM stokvel_groups WHERE id = $1 AND merchant_id = $2`,
      [req.params.id, merchantId],
    );
    if (!groupQ.rows[0]) {
      return res.status(404).json({ error: 'Stokvel not found' });
    }
    const loanQ = await pool.query(
      `SELECT * FROM stokvel_loans WHERE id = $1 AND stokvel_id = $2`,
      [req.params.loanId, req.params.id],
    );
    const loan = loanQ.rows[0];
    if (!loan) return res.status(404).json({ error: 'Loan not found' });
    if (loan.status === 'repaid') {
      return res.status(409).json({ error: 'Loan is already repaid' });
    }
    const now = new Date().toISOString();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE stokvel_loans SET status = 'repaid', repaid_at = $1 WHERE id = $2`,
        [now, loan.id],
      );
      if (loan.from_pool) {
        // Principal returns to the pool; interest stays with the lender track record.
        await client.query(
          `UPDATE stokvel_groups
              SET current_amount = current_amount + $1
            WHERE id = $2`,
          [loan.amount, req.params.id],
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    const freshLoan = await pool.query(
      `SELECT * FROM stokvel_loans WHERE id = $1`,
      [loan.id],
    );
    const freshGroup = await pool.query(
      `SELECT * FROM stokvel_groups WHERE id = $1`,
      [req.params.id],
    );
    return res.json({
      loan: toStokvelLoan(freshLoan.rows[0]),
      group: toStokvel(freshGroup.rows[0]),
    });
  },
);

extensionProgramsRouterPg.get('/layby', requireAuth, async (req, res) => {
  const pool = getPgPool();
  let merchantId: string;
  try {
    merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const r = await pool.query(
    `SELECT * FROM layby_orders WHERE merchant_id = $1 ORDER BY created_at DESC`,
    [merchantId],
  );
  return res.json({ orders: r.rows.map(toLayby) });
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
      }),
    )
    .default([]),
  status: z.enum(['active', 'completed', 'cancelled']).default('active'),
});

extensionProgramsRouterPg.post('/layby', requireAuth, async (req, res) => {
  const pool = getPgPool();
  let merchantId: string;
  try {
    merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const parsed = laybyBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  const b = parsed.data;
  await pool.query(
    `INSERT INTO layby_orders
      (id, merchant_id, customer_name, customer_phone, item_name, total_price, amount_paid, installments_json, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      merchantId,
      b.customerName,
      b.customerPhone.replace(/\s+/g, ''),
      b.itemName,
      b.totalPrice,
      b.amountPaid,
      JSON.stringify(b.installments),
      b.status,
      now,
    ],
  );
  const rowQ = await pool.query(`SELECT * FROM layby_orders WHERE id = $1`, [
    id,
  ]);
  return res.status(201).json({ order: toLayby(rowQ.rows[0]) });
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

extensionProgramsRouterPg.post(
  '/layby/:id/payments',
  requireAuth,
  async (req, res) => {
    const pool = getPgPool();
    let merchantId: string;
    try {
      merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
    } catch {
      return res.status(403).json({ error: 'Merchant profile required' });
    }
    const parsed = laybyPaymentBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const rowQ = await pool.query<LaybyRow>(
      `SELECT * FROM layby_orders WHERE id = $1 AND merchant_id = $2`,
      [req.params.id, merchantId],
    );
    const row = rowQ.rows[0];
    if (!row) return res.status(404).json({ error: 'Layby not found' });
    if (row.status !== 'active') {
      return res
        .status(409)
        .json({ error: `Layby is ${row.status} — payments closed.` });
    }
    const outstanding = Number((row.total_price - row.amount_paid).toFixed(2));
    if (outstanding <= 0) {
      return res.status(409).json({ error: 'Layby already paid in full.' });
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
    await pool.query(
      `UPDATE layby_orders SET amount_paid = $1, installments_json = $2, status = $3 WHERE id = $4`,
      [newPaid, JSON.stringify(installments), newStatus, row.id],
    );
    const freshQ = await pool.query<LaybyRow>(
      `SELECT * FROM layby_orders WHERE id = $1`,
      [row.id],
    );
    const fresh = freshQ.rows[0];
    return res.json({
      order: toLayby(fresh),
      applied,
      outstanding: Number((fresh.total_price - fresh.amount_paid).toFixed(2)),
    });
  },
);

extensionProgramsRouterPg.get(
  '/price-comparisons',
  requireAuth,
  async (req, res) => {
    const pool = getPgPool();
    let merchantId: string;
    try {
      merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
    } catch {
      return res.status(403).json({ error: 'Merchant profile required' });
    }
    const q =
      typeof req.query.merchantId === 'string' ? req.query.merchantId : '';
    if (q && q !== merchantId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const r = await pool.query(
      `SELECT * FROM price_comparisons WHERE merchant_id = $1 ORDER BY last_updated DESC`,
      [merchantId],
    );
    return res.json({ comparisons: r.rows.map(toPriceComparison) });
  },
);

const priceBody = z.object({
  productName: z.string().min(1),
  myPrice: z.coerce.number().nonnegative(),
  avgAreaPrice: z.coerce.number().nonnegative(),
  lowestAreaPrice: z.coerce.number().nonnegative(),
  highestAreaPrice: z.coerce.number().nonnegative(),
  competitors: z.coerce.number().int().nonnegative(),
});

extensionProgramsRouterPg.post(
  '/price-comparisons',
  requireAuth,
  async (req, res) => {
    const pool = getPgPool();
    let merchantId: string;
    try {
      merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
    } catch {
      return res.status(403).json({ error: 'Merchant profile required' });
    }
    const parsed = priceBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const b = parsed.data;
    await pool.query(
      `INSERT INTO price_comparisons
        (id, merchant_id, product_name, my_price, avg_area_price, lowest_area_price, highest_area_price, competitors, last_updated)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        merchantId,
        b.productName,
        b.myPrice,
        b.avgAreaPrice,
        b.lowestAreaPrice,
        b.highestAreaPrice,
        b.competitors,
        now,
      ],
    );
    const rowQ = await pool.query(
      `SELECT * FROM price_comparisons WHERE id = $1`,
      [id],
    );
    return res.status(201).json({ comparison: toPriceComparison(rowQ.rows[0]) });
  },
);

extensionProgramsRouterPg.get('/insurance', requireAuth, async (req, res) => {
  const pool = getPgPool();
  let merchantId: string;
  try {
    merchantId = await ensureMerchantIdPg(pool, req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const r = await pool.query(
    `SELECT * FROM insurance_policies WHERE merchant_id = $1`,
    [merchantId],
  );
  return res.json({ policies: r.rows.map(toInsurance) });
});

const insBody = z.object({
  provider: z.string().min(1),
  type: z.enum(['stock', 'fire', 'theft']),
  coverageAmount: z.coerce.number().positive(),
  monthlyPremium: z.coerce.number().positive(),
  status: z.enum(['active', 'pending', 'cancelled']).default('pending'),
  nextPaymentDate: z.string().min(1),
});

extensionProgramsRouterPg.post('/insurance', requireAuth, async (req, res) => {
  const pool = getPgPool();
  let merchantId: string;
  try {
    merchantId = await ensureMerchantIdPg(pool, req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const parsed = insBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const id = randomUUID();
  const b = parsed.data;
  await pool.query(
    `INSERT INTO insurance_policies
      (id, merchant_id, provider, type, coverage_amount, monthly_premium, status, next_payment_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      merchantId,
      b.provider,
      b.type,
      b.coverageAmount,
      b.monthlyPremium,
      b.status,
      b.nextPaymentDate,
    ],
  );
  const rowQ = await pool.query(
    `SELECT * FROM insurance_policies WHERE id = $1`,
    [id],
  );
  return res.status(201).json({ policy: toInsurance(rowQ.rows[0]) });
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

extensionProgramsRouterPg.get(
  '/insurance/:id/claims',
  requireAuth,
  async (req, res) => {
    const pool = getPgPool();
    let merchantId: string;
    try {
      merchantId = await ensureMerchantIdPg(pool, req.auth!.userId);
    } catch {
      return res.status(403).json({ error: 'Merchant profile required' });
    }
    const policyQ = await pool.query<{ id: string }>(
      `SELECT id FROM insurance_policies WHERE id = $1 AND merchant_id = $2`,
      [req.params.id, merchantId],
    );
    if (!policyQ.rows[0]) {
      return res.status(404).json({ error: 'Policy not found' });
    }
    const r = await pool.query<ClaimRow>(
      `SELECT * FROM insurance_claims WHERE policy_id = $1 ORDER BY created_at DESC`,
      [policyQ.rows[0].id],
    );
    return res.json({ claims: r.rows.map(toInsuranceClaim) });
  },
);

extensionProgramsRouterPg.post(
  '/insurance/:id/claims',
  requireAuth,
  async (req, res) => {
    const pool = getPgPool();
    let merchantId: string;
    try {
      merchantId = await ensureMerchantIdPg(pool, req.auth!.userId);
    } catch {
      return res.status(403).json({ error: 'Merchant profile required' });
    }
    const parsed = claimBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const policyQ = await pool.query<{
      id: string;
      status: string;
      coverage_amount: number;
    }>(
      `SELECT id, status, coverage_amount FROM insurance_policies
       WHERE id = $1 AND merchant_id = $2`,
      [req.params.id, merchantId],
    );
    const policy = policyQ.rows[0];
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
    await pool.query(
      `INSERT INTO insurance_claims
         (id, policy_id, merchant_id, type, description, claimed_amount, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'submitted', $7)`,
      [
        id,
        policy.id,
        merchantId,
        parsed.data.type,
        parsed.data.description.trim(),
        parsed.data.claimedAmount,
        now,
      ],
    );
    const rowQ = await pool.query<ClaimRow>(
      `SELECT * FROM insurance_claims WHERE id = $1`,
      [id],
    );
    return res.status(201).json({ claim: toInsuranceClaim(rowQ.rows[0]) });
  },
);

extensionProgramsRouterPg.get('/voice-notes', requireAuth, async (req, res) => {
  const pool = getPgPool();
  let merchantId: string;
  try {
    merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const r = await pool.query(
    `SELECT * FROM voice_notes WHERE merchant_id = $1 ORDER BY created_at DESC`,
    [merchantId],
  );
  return res.json({ notes: r.rows.map(toVoiceNote) });
});

const voiceBody = z.object({
  title: z.string().min(1),
  transcript: z.string().default(''),
  duration: z.coerce.number().nonnegative().default(0),
  category: z.enum(['reminder', 'debt', 'order', 'general']).default('general'),
});

extensionProgramsRouterPg.post(
  '/voice-notes',
  requireAuth,
  async (req, res) => {
    const pool = getPgPool();
    let merchantId: string;
    try {
      merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
    } catch {
      return res.status(403).json({ error: 'Merchant profile required' });
    }
    const parsed = voiceBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const b = parsed.data;
    await pool.query(
      `INSERT INTO voice_notes
        (id, merchant_id, title, transcript, duration, category, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, merchantId, b.title, b.transcript, b.duration, b.category, now],
    );
    const rowQ = await pool.query(`SELECT * FROM voice_notes WHERE id = $1`, [
      id,
    ]);
    return res.status(201).json({ note: toVoiceNote(rowQ.rows[0]) });
  },
);

extensionProgramsRouterPg.delete(
  '/voice-notes/:id',
  requireAuth,
  async (req, res) => {
    const pool = getPgPool();
    let merchantId: string;
    try {
      merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
    } catch {
      return res.status(403).json({ error: 'Merchant profile required' });
    }
    const r = await pool.query(
      `DELETE FROM voice_notes WHERE id = $1 AND merchant_id = $2`,
      [req.params.id, merchantId],
    );
    if ((r.rowCount ?? 0) === 0) {
      return res.status(404).json({ error: 'Not found' });
    }
    return res.json({ ok: true });
  },
);

extensionProgramsRouterPg.get(
  '/expiry-items',
  requireAuth,
  async (req, res) => {
    const pool = getPgPool();
    let merchantId: string;
    try {
      merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
    } catch {
      return res.status(403).json({ error: 'Merchant profile required' });
    }
    const r = await pool.query(
      `SELECT * FROM expiry_items WHERE merchant_id = $1 ORDER BY expiry_date`,
      [merchantId],
    );
    return res.json({ items: r.rows.map(toExpiryItem) });
  },
);

const expiryBody = z.object({
  productName: z.string().min(1),
  category: z.string().min(1),
  batchNumber: z.string().min(1),
  expiryDate: z.string().min(1),
  quantity: z.coerce.number().int().nonnegative(),
  supplierId: z.string().min(1),
  status: z.enum(['safe', 'expiring-soon', 'expired']).default('safe'),
});

extensionProgramsRouterPg.post(
  '/expiry-items',
  requireAuth,
  async (req, res) => {
    const pool = getPgPool();
    let merchantId: string;
    try {
      merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
    } catch {
      return res.status(403).json({ error: 'Merchant profile required' });
    }
    const parsed = expiryBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const id = randomUUID();
    const b = parsed.data;
    await pool.query(
      `INSERT INTO expiry_items
        (id, merchant_id, product_name, category, batch_number, expiry_date, quantity, supplier_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        merchantId,
        b.productName,
        b.category,
        b.batchNumber,
        b.expiryDate,
        b.quantity,
        b.supplierId,
        b.status,
      ],
    );
    const rowQ = await pool.query(`SELECT * FROM expiry_items WHERE id = $1`, [
      id,
    ]);
    return res.status(201).json({ item: toExpiryItem(rowQ.rows[0]) });
  },
);

extensionProgramsRouterPg.get(
  '/food-safety-alerts',
  requireAuth,
  async (req, res) => {
    const pool = getPgPool();
    let merchantId: string;
    try {
      merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
    } catch {
      return res.status(403).json({ error: 'Merchant profile required' });
    }
    const r = await pool.query(
      `SELECT * FROM food_safety_alerts
       WHERE merchant_id IS NULL OR merchant_id = $1
       ORDER BY created_at DESC LIMIT 100`,
      [merchantId],
    );
    return res.json({ alerts: r.rows.map(toFoodSafetyAlert) });
  },
);

const alertBody = z.object({
  type: z.enum(['recall', 'expiry', 'supplier', 'inspection']),
  title: z.string().min(1),
  description: z.string().min(1),
  severity: z.enum(['critical', 'warning', 'info']),
  merchantScope: z.boolean().default(true),
});

extensionProgramsRouterPg.post(
  '/food-safety-alerts',
  requireAuth,
  async (req, res) => {
    const pool = getPgPool();
    let merchantId: string;
    try {
      merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
    } catch {
      return res.status(403).json({ error: 'Merchant profile required' });
    }
    const parsed = alertBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const b = parsed.data;
    const midScope = b.merchantScope ? merchantId : null;
    await pool.query(
      `INSERT INTO food_safety_alerts
        (id, merchant_id, type, title, description, severity, created_at, is_read)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0)`,
      [id, midScope, b.type, b.title, b.description, b.severity, now],
    );
    const rowQ = await pool.query(
      `SELECT * FROM food_safety_alerts WHERE id = $1`,
      [id],
    );
    return res.status(201).json({ alert: toFoodSafetyAlert(rowQ.rows[0]) });
  },
);

extensionProgramsRouterPg.patch(
  '/food-safety-alerts/:id/read',
  requireAuth,
  async (req, res) => {
    const pool = getPgPool();
    await pool.query(
      `UPDATE food_safety_alerts SET is_read = 1 WHERE id = $1`,
      [req.params.id],
    );
    return res.json({ ok: true });
  },
);

extensionProgramsRouterPg.get(
  '/stock-movements',
  requireAuth,
  async (req, res) => {
    const pool = getPgPool();
    let merchantId: string;
    try {
      merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
    } catch {
      return res.status(403).json({ error: 'Merchant profile required' });
    }
    const r = await pool.query(
      `SELECT * FROM stock_movements WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 500`,
      [merchantId],
    );
    return res.json({ movements: r.rows.map(toStockMovement) });
  },
);

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

extensionProgramsRouterPg.post(
  '/stock-movements',
  requireAuth,
  async (req, res) => {
    const pool = getPgPool();
    let merchantId: string;
    try {
      merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
    } catch {
      return res.status(403).json({ error: 'Merchant profile required' });
    }
    const parsed = stockMoveBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const b = parsed.data;
    await pool.query(
      `INSERT INTO stock_movements
        (id, merchant_id, product_id, product_name, type, quantity, reason, cost_price_at_time, reference, notes, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
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
        now,
      ],
    );
    const rowQ = await pool.query(
      `SELECT * FROM stock_movements WHERE id = $1`,
      [id],
    );
    return res.status(201).json({ movement: toStockMovement(rowQ.rows[0]) });
  },
);
