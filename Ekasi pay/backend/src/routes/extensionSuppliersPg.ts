import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import { getPgPool } from '../dbPg.js';
import { formatCents, parseZarToCents } from '../money.js';
import {
  toSupplier,
  toSupplierOrder,
  toSupplierVerification,
} from '../extraMappers.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireMerchantIdPg } from '../services/merchantPg.js';

export const extensionSuppliersRouterPg = Router();

extensionSuppliersRouterPg.get('/suppliers', requireAuth, async (_req, res) => {
  const pool = getPgPool();
  const r = await pool.query(
    `SELECT * FROM suppliers ORDER BY lower(name)`,
  );
  return res.json({ suppliers: r.rows.map(toSupplier) });
});

const supplierBody = z.object({
  name: z.string().min(1),
  phone: z.string().min(9).max(20),
  category: z.string().min(1),
  deliveryDays: z.array(z.string()).default([]),
});

extensionSuppliersRouterPg.post('/suppliers', requireAuth, async (req, res) => {
  const pool = getPgPool();
  try {
    await requireMerchantIdPg(pool, req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const parsed = supplierBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const id = randomUUID();
  await pool.query(
    `INSERT INTO suppliers (id, name, phone, category, delivery_days_json)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      id,
      parsed.data.name,
      parsed.data.phone.replace(/\s+/g, ''),
      parsed.data.category,
      JSON.stringify(parsed.data.deliveryDays),
    ],
  );
  const rowQ = await pool.query(`SELECT * FROM suppliers WHERE id = $1`, [id]);
  return res.status(201).json({ supplier: toSupplier(rowQ.rows[0]) });
});

extensionSuppliersRouterPg.get(
  '/supplier-orders',
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
      `SELECT * FROM supplier_orders WHERE merchant_id = $1
       ORDER BY order_date DESC LIMIT 200`,
      [merchantId],
    );
    return res.json({ orders: r.rows.map(toSupplierOrder) });
  },
);

const orderBody = z.object({
  supplierId: z.string().min(1),
  items: z
    .array(
      z.object({
        name: z.string().min(1),
        quantity: z.coerce.number().int().positive(),
        unitCost: z.union([z.string(), z.number()]),
      }),
    )
    .min(1),
  total: z.union([z.string(), z.number()]),
  expectedDelivery: z.string().optional(),
});

extensionSuppliersRouterPg.post(
  '/supplier-orders',
  requireAuth,
  async (req, res) => {
    const pool = getPgPool();
    let merchantId: string;
    try {
      merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
    } catch {
      return res.status(403).json({ error: 'Merchant profile required' });
    }
    const parsed = orderBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const sup = await pool.query<{ id: string }>(
      `SELECT id FROM suppliers WHERE id = $1`,
      [parsed.data.supplierId],
    );
    if (!sup.rows[0]) {
      return res.status(404).json({ error: 'Supplier not found' });
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    await pool.query(
      `INSERT INTO supplier_orders
        (id, merchant_id, supplier_id, items_json, total_cents, status, order_date, expected_delivery)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)`,
      [
        id,
        merchantId,
        parsed.data.supplierId,
        JSON.stringify(
          parsed.data.items.map((item) => ({
            ...item,
            unitCost: formatCents(
              parseZarToCents(item.unitCost, { allowZero: true }),
            ),
          })),
        ),
        parseZarToCents(parsed.data.total, { allowZero: true }).toString(),
        now,
        parsed.data.expectedDelivery ?? null,
      ],
    );
    const rowQ = await pool.query(
      `SELECT * FROM supplier_orders WHERE id = $1`,
      [id],
    );
    return res.status(201).json({ order: toSupplierOrder(rowQ.rows[0]) });
  },
);

extensionSuppliersRouterPg.patch(
  '/supplier-orders/:id',
  requireAuth,
  async (req, res) => {
    const pool = getPgPool();
    let merchantId: string;
    try {
      merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
    } catch {
      return res.status(403).json({ error: 'Merchant profile required' });
    }
    const status = z
      .enum(['pending', 'confirmed', 'delivered'])
      .safeParse(req.body?.status);
    if (!status.success) {
      return res.status(400).json({ error: status.error.flatten() });
    }
    const rowQ = await pool.query(
      `SELECT * FROM supplier_orders WHERE id = $1`,
      [req.params.id],
    );
    const row = rowQ.rows[0];
    if (!row || row.merchant_id !== merchantId) {
      return res.status(404).json({ error: 'Order not found' });
    }
    await pool.query(`UPDATE supplier_orders SET status = $1 WHERE id = $2`, [
      status.data,
      row.id,
    ]);
    const nextQ = await pool.query(
      `SELECT * FROM supplier_orders WHERE id = $1`,
      [row.id],
    );
    return res.json({ order: toSupplierOrder(nextQ.rows[0]) });
  },
);

extensionSuppliersRouterPg.get(
  '/supplier-verifications',
  requireAuth,
  async (_req, res) => {
    const pool = getPgPool();
    const r = await pool.query(
      `SELECT * FROM supplier_verifications ORDER BY supplier_id`,
    );
    return res.json({ verifications: r.rows.map(toSupplierVerification) });
  },
);

const verifyBody = z.object({
  cipcRegistered: z.boolean(),
  healthDeptApproved: z.boolean(),
  lastInspectionDate: z.string().min(1),
  certificateExpiry: z.string().min(1),
  verificationStatus: z.enum([
    'verified',
    'pending',
    'unverified',
    'flagged',
  ]),
  riskLevel: z.enum(['low', 'medium', 'high']),
});

extensionSuppliersRouterPg.put(
  '/supplier-verifications/:supplierId',
  requireAuth,
  async (req, res) => {
    const pool = getPgPool();
    try {
      await requireMerchantIdPg(pool, req.auth!.userId);
    } catch {
      return res.status(403).json({ error: 'Merchant profile required' });
    }
    const supplierId = req.params.supplierId;
    const parsed = verifyBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const sup = await pool.query(`SELECT id FROM suppliers WHERE id = $1`, [
      supplierId,
    ]);
    if (!sup.rows[0]) {
      return res.status(404).json({ error: 'Supplier not found' });
    }
    const v = parsed.data;
    await pool.query(
      `INSERT INTO supplier_verifications (
        supplier_id, cipc_registered, health_dept_approved, last_inspection_date,
        certificate_expiry, verification_status, risk_level
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (supplier_id) DO UPDATE SET
        cipc_registered = EXCLUDED.cipc_registered,
        health_dept_approved = EXCLUDED.health_dept_approved,
        last_inspection_date = EXCLUDED.last_inspection_date,
        certificate_expiry = EXCLUDED.certificate_expiry,
        verification_status = EXCLUDED.verification_status,
        risk_level = EXCLUDED.risk_level`,
      [
        supplierId,
        v.cipcRegistered ? 1 : 0,
        v.healthDeptApproved ? 1 : 0,
        v.lastInspectionDate,
        v.certificateExpiry,
        v.verificationStatus,
        v.riskLevel,
      ],
    );
    const rowQ = await pool.query(
      `SELECT * FROM supplier_verifications WHERE supplier_id = $1`,
      [supplierId],
    );
    return res.json({ verification: toSupplierVerification(rowQ.rows[0]) });
  },
);
