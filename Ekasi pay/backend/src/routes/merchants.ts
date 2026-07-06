import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import { getDb } from '../db.js';
import { toMerchant } from '../mappers.js';
import { requireAuth } from '../middleware/requireAuth.js';

export const merchantsRouter = Router();

type MerchantRow = {
  id: string;
  user_id: string;
  business_name: string;
  location: string;
  category: string;
};

merchantsRouter.get('/merchants/me', requireAuth, (req, res) => {
  const database = getDb();
  const row = database
    .prepare('SELECT * FROM merchants WHERE user_id = ?')
    .get(req.auth!.userId) as MerchantRow | undefined;
  if (!row) {
    return res.json({ merchant: null });
  }
  return res.json({ merchant: toMerchant(row) });
});

/**
 * Idempotent merchant onboarding. Returns the user's merchant row, creating a
 * sensible default if one does not yet exist (e.g. accounts registered as
 * customer that later switch to merchant mode, or older accounts pre-feature).
 */
merchantsRouter.post('/merchants/me', requireAuth, (req, res) => {
  const database = getDb();
  const userId = req.auth!.userId;

  const existing = database
    .prepare('SELECT * FROM merchants WHERE user_id = ?')
    .get(userId) as MerchantRow | undefined;
  if (existing) {
    return res.json({ merchant: toMerchant(existing) });
  }

  const user = database
    .prepare('SELECT name FROM users WHERE id = ?')
    .get(userId) as { name: string } | undefined;
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const body = (req.body ?? {}) as {
    businessName?: string;
    location?: string;
    category?: string;
  };
  const businessName =
    body.businessName?.trim() || `${user.name}'s Shop`;
  const location = body.location?.trim() || 'South Africa';
  const category = body.category?.trim() || 'Retail';

  const id = randomUUID();
  database
    .prepare(
      `INSERT INTO merchants (id, user_id, business_name, location, category)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(id, userId, businessName, location, category);

  const row = database
    .prepare('SELECT * FROM merchants WHERE id = ?')
    .get(id) as MerchantRow;
  return res.status(201).json({ merchant: toMerchant(row) });
});

const merchantPatchBody = z.object({
  businessName: z.string().trim().min(1).max(120).optional(),
  location: z.string().trim().min(1).max(120).optional(),
  category: z.string().trim().min(1).max(60).optional(),
});

/** Edit the authenticated user's merchant profile (business name, location, category). */
merchantsRouter.patch('/merchants/me', requireAuth, (req, res) => {
  const parsed = merchantPatchBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const updates: string[] = [];
  const values: (string | number)[] = [];
  if (parsed.data.businessName !== undefined) {
    updates.push('business_name = ?');
    values.push(parsed.data.businessName);
  }
  if (parsed.data.location !== undefined) {
    updates.push('location = ?');
    values.push(parsed.data.location);
  }
  if (parsed.data.category !== undefined) {
    updates.push('category = ?');
    values.push(parsed.data.category);
  }
  if (updates.length === 0) {
    return res.status(400).json({ error: 'No fields to update.' });
  }

  const database = getDb();
  const row = database
    .prepare('SELECT * FROM merchants WHERE user_id = ?')
    .get(req.auth!.userId) as MerchantRow | undefined;
  if (!row) {
    return res.status(404).json({ error: 'Merchant profile not set up yet.' });
  }
  values.push(row.id);
  database
    .prepare(`UPDATE merchants SET ${updates.join(', ')} WHERE id = ?`)
    .run(...values);
  const fresh = database
    .prepare('SELECT * FROM merchants WHERE id = ?')
    .get(row.id) as MerchantRow;
  return res.json({ merchant: toMerchant(fresh) });
});
