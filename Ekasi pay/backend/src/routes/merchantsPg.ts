import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import { getPgPool } from '../dbPg.js';
import { toMerchant } from '../mappers.js';
import { requireAuth } from '../middleware/requireAuth.js';

export const merchantsRouterPg = Router();

type MerchantRow = {
  id: string;
  user_id: string;
  business_name: string;
  location: string;
  category: string;
};

merchantsRouterPg.get('/merchants/me', requireAuth, async (req, res) => {
  const pool = getPgPool();
  const q = await pool.query<MerchantRow>(
    `SELECT * FROM merchants WHERE user_id = $1`,
    [req.auth!.userId],
  );
  const row = q.rows[0];
  if (!row) return res.json({ merchant: null });
  return res.json({ merchant: toMerchant(row) });
});

merchantsRouterPg.post('/merchants/me', requireAuth, async (req, res) => {
  const pool = getPgPool();
  const userId = req.auth!.userId;

  const existingQ = await pool.query<MerchantRow>(
    `SELECT * FROM merchants WHERE user_id = $1`,
    [userId],
  );
  const existing = existingQ.rows[0];
  if (existing) return res.json({ merchant: toMerchant(existing) });

  const userQ = await pool.query<{ name: string }>(
    `SELECT name FROM users WHERE id = $1`,
    [userId],
  );
  const user = userQ.rows[0];
  if (!user) return res.status(404).json({ error: 'User not found' });

  const body = (req.body ?? {}) as {
    businessName?: string;
    location?: string;
    category?: string;
  };
  const businessName = body.businessName?.trim() || `${user.name}'s Shop`;
  const location = body.location?.trim() || 'South Africa';
  const category = body.category?.trim() || 'Retail';

  const id = randomUUID();
  await pool.query(
    `INSERT INTO merchants (id, user_id, business_name, location, category)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, userId, businessName, location, category],
  );
  const rowQ = await pool.query<MerchantRow>(
    `SELECT * FROM merchants WHERE id = $1`,
    [id],
  );
  return res.status(201).json({ merchant: toMerchant(rowQ.rows[0]) });
});

const merchantPatchBody = z.object({
  businessName: z.string().trim().min(1).max(120).optional(),
  location: z.string().trim().min(1).max(120).optional(),
  category: z.string().trim().min(1).max(60).optional(),
});

merchantsRouterPg.patch('/merchants/me', requireAuth, async (req, res) => {
  const parsed = merchantPatchBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const pool = getPgPool();
  const rowQ = await pool.query<MerchantRow>(
    `SELECT * FROM merchants WHERE user_id = $1`,
    [req.auth!.userId],
  );
  const row = rowQ.rows[0];
  if (!row) {
    return res.status(404).json({ error: 'Merchant profile not set up yet.' });
  }

  const next = {
    business_name: parsed.data.businessName ?? row.business_name,
    location: parsed.data.location ?? row.location,
    category: parsed.data.category ?? row.category,
  };
  await pool.query(
    `UPDATE merchants
        SET business_name = $1, location = $2, category = $3
      WHERE id = $4`,
    [next.business_name, next.location, next.category, row.id],
  );
  const freshQ = await pool.query<MerchantRow>(
    `SELECT * FROM merchants WHERE id = $1`,
    [row.id],
  );
  return res.json({ merchant: toMerchant(freshQ.rows[0]) });
});
