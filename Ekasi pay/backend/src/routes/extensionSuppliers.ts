import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import { getDb } from '../db.js';
import {
  toSupplier,
  toSupplierOrder,
  toSupplierVerification,
} from '../extraMappers.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireMerchantId } from '../services/merchant.js';

export const extensionSuppliersRouter = Router();

extensionSuppliersRouter.get('/suppliers', requireAuth, (_req, res) => {
  const database = getDb();
  const rows = database
    .prepare('SELECT * FROM suppliers ORDER BY name COLLATE NOCASE')
    .all() as {
    id: string;
    name: string;
    phone: string;
    category: string;
    delivery_days_json: string;
  }[];
  return res.json({ suppliers: rows.map(toSupplier) });
});

const supplierBody = z.object({
  name: z.string().min(1),
  phone: z.string().min(9).max(20),
  category: z.string().min(1),
  deliveryDays: z.array(z.string()).default([]),
});

extensionSuppliersRouter.post('/suppliers', requireAuth, (req, res) => {
  try {
    requireMerchantId(req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const parsed = supplierBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const database = getDb();
  const id = randomUUID();
  database
    .prepare(
      `INSERT INTO suppliers (id, name, phone, category, delivery_days_json)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      id,
      parsed.data.name,
      parsed.data.phone.replace(/\s+/g, ''),
      parsed.data.category,
      JSON.stringify(parsed.data.deliveryDays)
    );
  const row = database.prepare('SELECT * FROM suppliers WHERE id = ?').get(id) as {
    id: string;
    name: string;
    phone: string;
    category: string;
    delivery_days_json: string;
  };
  return res.status(201).json({ supplier: toSupplier(row) });
});

extensionSuppliersRouter.get('/supplier-orders', requireAuth, (req, res) => {
  let merchantId: string;
  try {
    merchantId = requireMerchantId(req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const q =
    typeof req.query.merchantId === 'string' ? req.query.merchantId : '';
  if (q && q !== merchantId) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const database = getDb();
  const rows = database
    .prepare(
      `SELECT * FROM supplier_orders WHERE merchant_id = ?
       ORDER BY datetime(order_date) DESC LIMIT 200`
    )
    .all(merchantId) as {
    id: string;
    merchant_id: string;
    supplier_id: string;
    items_json: string;
    total: number;
    status: string;
    order_date: string;
    expected_delivery: string | null;
  }[];
  return res.json({ orders: rows.map(toSupplierOrder) });
});

const orderBody = z.object({
  supplierId: z.string().min(1),
  items: z
    .array(
      z.object({
        name: z.string().min(1),
        quantity: z.coerce.number().int().positive(),
        unitCost: z.coerce.number().nonnegative(),
      })
    )
    .min(1),
  total: z.coerce.number().nonnegative(),
  expectedDelivery: z.string().optional(),
});

extensionSuppliersRouter.post('/supplier-orders', requireAuth, (req, res) => {
  let merchantId: string;
  try {
    merchantId = requireMerchantId(req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const parsed = orderBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const database = getDb();
  const sup = database
    .prepare('SELECT id FROM suppliers WHERE id = ?')
    .get(parsed.data.supplierId) as { id: string } | undefined;
  if (!sup) return res.status(404).json({ error: 'Supplier not found' });
  const id = randomUUID();
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO supplier_orders (id, merchant_id, supplier_id, items_json, total, status, order_date, expected_delivery)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
    )
    .run(
      id,
      merchantId,
      parsed.data.supplierId,
      JSON.stringify(parsed.data.items),
      parsed.data.total,
      now,
      parsed.data.expectedDelivery ?? null
    );
  const row = database.prepare('SELECT * FROM supplier_orders WHERE id = ?').get(id) as {
    id: string;
    merchant_id: string;
    supplier_id: string;
    items_json: string;
    total: number;
    status: string;
    order_date: string;
    expected_delivery: string | null;
  };
  return res.status(201).json({ order: toSupplierOrder(row) });
});

extensionSuppliersRouter.patch('/supplier-orders/:id', requireAuth, (req, res) => {
  let merchantId: string;
  try {
    merchantId = requireMerchantId(req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const status = z
    .enum(['pending', 'confirmed', 'delivered'])
    .safeParse(req.body?.status);
  if (!status.success) {
    return res.status(400).json({ error: status.error.flatten() });
  }
  const database = getDb();
  const row = database
    .prepare('SELECT * FROM supplier_orders WHERE id = ?')
    .get(req.params.id) as
    | {
        id: string;
        merchant_id: string;
        supplier_id: string;
        items_json: string;
        total: number;
        status: string;
        order_date: string;
        expected_delivery: string | null;
      }
    | undefined;
  if (!row || row.merchant_id !== merchantId) {
    return res.status(404).json({ error: 'Order not found' });
  }
  database
    .prepare('UPDATE supplier_orders SET status = ? WHERE id = ?')
    .run(status.data, row.id);
  const next = database.prepare('SELECT * FROM supplier_orders WHERE id = ?').get(row.id) as {
    id: string;
    merchant_id: string;
    supplier_id: string;
    items_json: string;
    total: number;
    status: string;
    order_date: string;
    expected_delivery: string | null;
  };
  return res.json({ order: toSupplierOrder(next) });
});

extensionSuppliersRouter.get('/supplier-verifications', requireAuth, (_req, res) => {
  const database = getDb();
  const rows = database
    .prepare('SELECT * FROM supplier_verifications ORDER BY supplier_id')
    .all() as {
    supplier_id: string;
    cipc_registered: number;
    health_dept_approved: number;
    last_inspection_date: string;
    certificate_expiry: string;
    verification_status: string;
    risk_level: string;
  }[];
  return res.json({ verifications: rows.map(toSupplierVerification) });
});

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

extensionSuppliersRouter.put(
  '/supplier-verifications/:supplierId',
  requireAuth,
  (req, res) => {
    try {
      requireMerchantId(req.auth!.userId);
    } catch {
      return res.status(403).json({ error: 'Merchant profile required' });
    }
    const supplierId = req.params.supplierId;
    const parsed = verifyBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const database = getDb();
    const sup = database.prepare('SELECT id FROM suppliers WHERE id = ?').get(supplierId);
    if (!sup) return res.status(404).json({ error: 'Supplier not found' });
    const v = parsed.data;
    database
      .prepare(
        `INSERT INTO supplier_verifications (
          supplier_id, cipc_registered, health_dept_approved, last_inspection_date,
          certificate_expiry, verification_status, risk_level
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(supplier_id) DO UPDATE SET
          cipc_registered = excluded.cipc_registered,
          health_dept_approved = excluded.health_dept_approved,
          last_inspection_date = excluded.last_inspection_date,
          certificate_expiry = excluded.certificate_expiry,
          verification_status = excluded.verification_status,
          risk_level = excluded.risk_level`
      )
      .run(
        supplierId,
        v.cipcRegistered ? 1 : 0,
        v.healthDeptApproved ? 1 : 0,
        v.lastInspectionDate,
        v.certificateExpiry,
        v.verificationStatus,
        v.riskLevel
      );
    const row = database.prepare('SELECT * FROM supplier_verifications WHERE supplier_id = ?').get(supplierId) as {
      supplier_id: string;
      cipc_registered: number;
      health_dept_approved: number;
      last_inspection_date: string;
      certificate_expiry: string;
      verification_status: string;
      risk_level: string;
    };
    return res.json({ verification: toSupplierVerification(row) });
  }
);
