import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import { getPgPool } from '../dbPg.js';
import {
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
import {
  formatCents,
  multiplyCentsByRate,
  nonnegativeMoneyNumber,
  parseIntegerCents,
  parseZarToCents,
  positiveMoneyNumber,
  type Cents,
} from '../money.js';
import { idempotentPg } from '../middleware/idempotencyPg.js';
import { requireApprovedMerchant } from '../middleware/requireApprovedMerchant.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { getLoadSheddingSlotsPg } from '../services/loadSheddingPg.js';
import {
  ensureMerchantIdPg,
  requireMerchantIdPg,
} from '../services/merchantPg.js';

export const extensionProgramsRouterPg = Router();
extensionProgramsRouterPg.use(requireAuth, requireApprovedMerchant);

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
  const contribByGroup = new Map<
    string,
    ReturnType<typeof toStokvelContribution>[]
  >();
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
    const cq = await pool.query(
      `SELECT * FROM stokvel_contributions
        WHERE stokvel_id = ANY($1::text[])
        ORDER BY period_month DESC, created_at DESC`,
      [ids],
    );
    for (const row of cq.rows) {
      const c = toStokvelContribution(row);
      const list = contribByGroup.get(c.stokvelId) ?? [];
      list.push(c);
      contribByGroup.set(c.stokvelId, list);
    }
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
        contributed: nonnegativeMoneyNumber,
      }),
    )
    .default([]),
  targetAmount: positiveMoneyNumber,
  currentAmount: nonnegativeMoneyNumber,
  frequency: z.enum(['weekly', 'monthly']),
  nextPayoutDate: z.string().min(1),
});

extensionProgramsRouterPg.post(
  '/stokvel',
  requireAuth,
  idempotentPg('POST /stokvel'),
  async (req, res) => {
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
      (id, merchant_id, name, members_json, target_amount_cents, current_amount_cents, frequency, next_payout_date, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      merchantId,
      b.name,
      JSON.stringify(
        b.members.map((member) => ({
          ...member,
          contributed: formatCents(
            parseZarToCents(member.contributed, { allowZero: true }),
          ),
        })),
      ),
      parseZarToCents(b.targetAmount).toString(),
      parseZarToCents(b.currentAmount, { allowZero: true }).toString(),
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
  },
);

const stokvelMembersBody = z.object({
  members: z.array(
    z.object({
      name: z.string().min(1),
      phone: z
        .string()
        .min(9)
        .max(20)
        .transform((v) => v.replace(/\s+/g, '')),
      contributed: nonnegativeMoneyNumber.default(0),
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
    const totalCents = parsed.data.members.reduce(
      (sum, member) =>
        (sum +
          parseZarToCents(member.contributed, { allowZero: true })) as Cents,
      0n as Cents,
    );
    const currentCents = parseIntegerCents(row.current_amount_cents, {
      allowZero: true,
    });
    await pool.query(
      `UPDATE stokvel_groups SET members_json = $1, current_amount_cents = $2 WHERE id = $3`,
      [
        JSON.stringify(
          parsed.data.members.map((member) => ({
            ...member,
            contributed: formatCents(
              parseZarToCents(member.contributed, { allowZero: true }),
            ),
          })),
        ),
        (totalCents > currentCents ? totalCents : currentCents).toString(),
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
  amount: positiveMoneyNumber,
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
  idempotentPg('POST /stokvel/:id/loans'),
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
      current_amount_cents: string;
    }>(
      `SELECT id, current_amount_cents FROM stokvel_groups WHERE id = $1 AND merchant_id = $2`,
      [req.params.id, merchantId],
    );
    const group = groupQ.rows[0];
    if (!group) return res.status(404).json({ error: 'Stokvel not found' });

    const b = parsed.data;
    const amountCents = parseZarToCents(b.amount);
    const poolCents = parseIntegerCents(group.current_amount_cents, {
      allowZero: true,
    });
    if (b.fromPool && poolCents < amountCents) {
      return res.status(400).json({
        error: `Pool only has R${formatCents(poolCents)} — not enough to loan R${formatCents(amountCents)}.`,
      });
    }

    const interestCents = multiplyCentsByRate(amountCents, {
      units: BigInt(b.interestRatePercent),
      scale: 100n,
    });
    const totalDueCents = (amountCents + interestCents) as Cents;
    const id = randomUUID();
    const now = new Date().toISOString();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO stokvel_loans
          (id, stokvel_id, lender_name, lender_phone, borrower_name, borrower_phone,
           amount_cents, interest_rate_percent, interest_amount_cents, total_due_cents, from_pool,
           status, notes, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active',$12,$13)`,
        [
          id,
          group.id,
          b.lenderName,
          b.lenderPhone,
          b.borrowerName,
          b.borrowerPhone,
          amountCents.toString(),
          b.interestRatePercent,
          interestCents.toString(),
          totalDueCents.toString(),
          b.fromPool,
          b.notes ?? null,
          now,
        ],
      );
      if (b.fromPool) {
        await client.query(
          `UPDATE stokvel_groups
              SET current_amount_cents = current_amount_cents - $1
            WHERE id = $2`,
          [amountCents.toString(), group.id],
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
  idempotentPg('PATCH /stokvel/:id/loans/:loanId/repay'),
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
              SET current_amount_cents = current_amount_cents + $1
            WHERE id = $2`,
          [loan.amount_cents, req.params.id],
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

const periodMonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM for the contribution month');

const stokvelContributionBody = z.object({
  memberPhone: z
    .string()
    .min(9)
    .max(20)
    .transform((v) => v.replace(/\s+/g, '')),
  amount: positiveMoneyNumber,
  periodMonth: periodMonthSchema,
  notes: z.string().trim().max(500).optional(),
});

extensionProgramsRouterPg.post(
  '/stokvel/:id/contributions',
  requireAuth,
  idempotentPg('POST /stokvel/:id/contributions'),
  async (req, res) => {
    const pool = getPgPool();
    let merchantId: string;
    try {
      merchantId = await ensureMerchantIdPg(pool, req.auth!.userId);
    } catch {
      return res.status(403).json({ error: 'Merchant profile required' });
    }
    const parsed = stokvelContributionBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const groupQ = await pool.query<{
      id: string;
      members_json: string;
      current_amount_cents: string;
    }>(
      `SELECT id, members_json, current_amount_cents FROM stokvel_groups
        WHERE id = $1 AND merchant_id = $2`,
      [req.params.id, merchantId],
    );
    const group = groupQ.rows[0];
    if (!group) return res.status(404).json({ error: 'Stokvel not found' });

    const members = JSON.parse(group.members_json) as {
      name: string;
      phone: string;
      contributed: string | number;
    }[];
    const member = members.find((m) => m.phone === parsed.data.memberPhone);
    if (!member) {
      return res.status(400).json({
        error: 'Member not found in this stokvel. Add them under Members first.',
      });
    }

    const existingQ = await pool.query<{ id: string; amount_cents: string }>(
      `SELECT id, amount_cents FROM stokvel_contributions
        WHERE stokvel_id = $1 AND member_phone = $2 AND period_month = $3`,
      [group.id, member.phone, parsed.data.periodMonth],
    );
    const existing = existingQ.rows[0];
    const now = new Date().toISOString();
    const newAmountCents = parseZarToCents(parsed.data.amount);
    const deltaCents = (newAmountCents -
      (existing ? parseIntegerCents(existing.amount_cents) : 0n)) as Cents;
    const id = existing?.id ?? randomUUID();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (existing) {
        await client.query(
          `UPDATE stokvel_contributions
              SET amount_cents = $1, notes = $2, member_name = $3
            WHERE id = $4`,
          [
            newAmountCents.toString(),
            parsed.data.notes ?? null,
            member.name,
            existing.id,
          ],
        );
      } else {
        await client.query(
          `INSERT INTO stokvel_contributions
            (id, stokvel_id, member_name, member_phone, amount_cents, period_month, notes, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            id,
            group.id,
            member.name,
            member.phone,
            newAmountCents.toString(),
            parsed.data.periodMonth,
            parsed.data.notes ?? null,
            now,
          ],
        );
      }

      const nextMembers = members.map((m) =>
        m.phone === member.phone
          ? {
              ...m,
              contributed: formatCents(
                (parseZarToCents(m.contributed, { allowZero: true }) +
                  deltaCents) as Cents,
              ),
            }
          : m,
      );
      await client.query(
        `UPDATE stokvel_groups
            SET members_json = $1,
                current_amount_cents = GREATEST(0, current_amount_cents + $2)
          WHERE id = $3`,
        [JSON.stringify(nextMembers), deltaCents.toString(), group.id],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    const contribQ = await pool.query(
      `SELECT * FROM stokvel_contributions WHERE id = $1`,
      [id],
    );
    const freshGroup = await pool.query(
      `SELECT * FROM stokvel_groups WHERE id = $1`,
      [group.id],
    );
    return res.status(existing ? 200 : 201).json({
      contribution: toStokvelContribution(contribQ.rows[0]),
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
  totalPrice: positiveMoneyNumber,
  amountPaid: nonnegativeMoneyNumber,
  installments: z
    .array(
      z.object({
        amount: nonnegativeMoneyNumber,
        date: z.string(),
      }),
    )
    .default([]),
  status: z.enum(['active', 'completed', 'cancelled']).default('active'),
});

extensionProgramsRouterPg.post(
  '/layby',
  requireAuth,
  idempotentPg('POST /layby'),
  async (req, res) => {
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
      (id, merchant_id, customer_name, customer_phone, item_name, total_price_cents, amount_paid_cents, installments_json, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      merchantId,
      b.customerName,
      b.customerPhone.replace(/\s+/g, ''),
      b.itemName,
      parseZarToCents(b.totalPrice).toString(),
      parseZarToCents(b.amountPaid, { allowZero: true }).toString(),
      JSON.stringify(
        b.installments.map((installment) => ({
          ...installment,
          amount: formatCents(
            parseZarToCents(installment.amount, { allowZero: true }),
          ),
        })),
      ),
      b.status,
      now,
    ],
  );
  const rowQ = await pool.query(`SELECT * FROM layby_orders WHERE id = $1`, [
    id,
  ]);
  return res.status(201).json({ order: toLayby(rowQ.rows[0]) });
  },
);

const laybyPaymentBody = z.object({
  amount: positiveMoneyNumber,
  date: z.string().min(1).optional(),
});

type LaybyRow = {
  id: string;
  merchant_id: string;
  customer_name: string;
  customer_phone: string;
  item_name: string;
  total_price_cents: string;
  amount_paid_cents: string;
  installments_json: string;
  status: string;
  created_at: string;
};

extensionProgramsRouterPg.post(
  '/layby/:id/payments',
  requireAuth,
  idempotentPg('POST /layby/:id/payments'),
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
    const totalCents = parseIntegerCents(row.total_price_cents);
    const paidCents = parseIntegerCents(row.amount_paid_cents, {
      allowZero: true,
    });
    const outstandingCents = (totalCents - paidCents) as Cents;
    if (outstandingCents <= 0n) {
      return res.status(409).json({ error: 'Layby already paid in full.' });
    }
    const requestedCents = parseZarToCents(parsed.data.amount);
    const appliedCents =
      requestedCents < outstandingCents ? requestedCents : outstandingCents;
    let installments: { amount: string; date: string }[] = [];
    try {
      installments = JSON.parse(row.installments_json || '[]');
    } catch {
      installments = [];
    }
    installments.push({
      amount: formatCents(appliedCents),
      date: parsed.data.date ?? new Date().toISOString(),
    });
    const newPaidCents = (paidCents + appliedCents) as Cents;
    const newStatus = newPaidCents >= totalCents ? 'completed' : 'active';
    await pool.query(
      `UPDATE layby_orders SET amount_paid_cents = $1, installments_json = $2, status = $3 WHERE id = $4`,
      [
        newPaidCents.toString(),
        JSON.stringify(installments),
        newStatus,
        row.id,
      ],
    );
    const freshQ = await pool.query<LaybyRow>(
      `SELECT * FROM layby_orders WHERE id = $1`,
      [row.id],
    );
    const fresh = freshQ.rows[0];
    return res.json({
      order: toLayby(fresh),
      applied: formatCents(appliedCents),
      outstanding: formatCents(
        (parseIntegerCents(fresh.total_price_cents) -
          parseIntegerCents(fresh.amount_paid_cents, {
            allowZero: true,
          })) as Cents,
      ),
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
  myPrice: nonnegativeMoneyNumber,
  avgAreaPrice: nonnegativeMoneyNumber,
  lowestAreaPrice: nonnegativeMoneyNumber,
  highestAreaPrice: nonnegativeMoneyNumber,
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
        (id, merchant_id, product_name, my_price_cents, avg_area_price_cents, lowest_area_price_cents, highest_area_price_cents, competitors, last_updated)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        merchantId,
        b.productName,
        parseZarToCents(b.myPrice, { allowZero: true }).toString(),
        parseZarToCents(b.avgAreaPrice, { allowZero: true }).toString(),
        parseZarToCents(b.lowestAreaPrice, { allowZero: true }).toString(),
        parseZarToCents(b.highestAreaPrice, { allowZero: true }).toString(),
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
  coverageAmount: positiveMoneyNumber,
  monthlyPremium: positiveMoneyNumber,
  status: z.enum(['active', 'pending', 'cancelled']).default('pending'),
  nextPaymentDate: z.string().min(1),
});

extensionProgramsRouterPg.post(
  '/insurance',
  requireAuth,
  idempotentPg('POST /insurance'),
  async (req, res) => {
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
      (id, merchant_id, provider, type, coverage_amount_cents, monthly_premium_cents, status, next_payment_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      merchantId,
      b.provider,
      b.type,
      parseZarToCents(b.coverageAmount).toString(),
      parseZarToCents(b.monthlyPremium).toString(),
      b.status,
      b.nextPaymentDate,
    ],
  );
  const rowQ = await pool.query(
    `SELECT * FROM insurance_policies WHERE id = $1`,
    [id],
  );
  return res.status(201).json({ policy: toInsurance(rowQ.rows[0]) });
  },
);

const claimBody = z.object({
  type: z.enum(['stock', 'fire', 'theft']),
  description: z.string().min(3).max(2000),
  claimedAmount: positiveMoneyNumber,
});

type ClaimRow = {
  id: string;
  policy_id: string;
  merchant_id: string;
  type: string;
  description: string;
  claimed_amount_cents: string;
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
    claimedAmount: formatCents(parseIntegerCents(row.claimed_amount_cents)),
    status: row.status,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at ?? undefined,
    adminNote: row.admin_note ?? undefined,
  };
}

extensionProgramsRouterPg.get(
  '/insurance/:id/claims',
  requireAuth,
  idempotentPg('POST /insurance/:id/claims'),
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
      coverage_amount_cents: string;
    }>(
      `SELECT id, status, coverage_amount_cents FROM insurance_policies
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
    const claimedCents = parseZarToCents(parsed.data.claimedAmount);
    const coverageCents = parseIntegerCents(policy.coverage_amount_cents);
    if (claimedCents > coverageCents) {
      return res.status(400).json({
        error: `Claimed amount exceeds coverage (R${formatCents(coverageCents)}).`,
      });
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    await pool.query(
      `INSERT INTO insurance_claims
         (id, policy_id, merchant_id, type, description, claimed_amount_cents, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'submitted', $7)`,
      [
        id,
        policy.id,
        merchantId,
        parsed.data.type,
        parsed.data.description.trim(),
        claimedCents.toString(),
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
  costPriceAtTime: nonnegativeMoneyNumber.optional(),
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
        (id, merchant_id, product_id, product_name, type, quantity, reason, cost_price_at_time_cents, reference, notes, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id,
        merchantId,
        b.productId,
        b.productName,
        b.type,
        b.quantity,
        b.reason,
        b.costPriceAtTime === undefined
          ? null
          : parseZarToCents(b.costPriceAtTime, { allowZero: true }).toString(),
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
