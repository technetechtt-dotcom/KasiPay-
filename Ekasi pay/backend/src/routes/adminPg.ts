import { Router } from 'express';
import { z } from 'zod';

import { getPgPool } from '../dbPg.js';
import { toComplianceFlag, toLoan } from '../extraMappers.js';
import { requireAuth, requireRoles } from '../middleware/requireAuth.js';
import { recordAuditEventPg } from '../services/auditPg.js';
import {
  adminClaimListQuerySchema,
  adminClaimPatchBodySchema,
} from '../validation.js';

export const adminRouterPg = Router();

const loanListQuery = z.object({
  status: z
    .enum(['pending', 'approved', 'rejected', 'disbursed', 'repaid'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

adminRouterPg.get(
  '/admin/loans',
  requireAuth,
  requireRoles('admin'),
  async (req, res) => {
    const parsed = loanListQuery.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const pool = getPgPool();
    const r = parsed.data.status
      ? await pool.query(
          `SELECT * FROM loans WHERE status = $1 ORDER BY id DESC LIMIT $2`,
          [parsed.data.status, parsed.data.limit],
        )
      : await pool.query(
          `SELECT * FROM loans ORDER BY id DESC LIMIT $1`,
          [parsed.data.limit],
        );
    return res.json({ loans: r.rows.map(toLoan) });
  },
);

const flagPatchBody = z.object({
  status: z.enum(['open', 'resolved', 'dismissed']),
});

adminRouterPg.patch(
  '/admin/compliance/flags/:id',
  requireAuth,
  requireRoles('admin'),
  async (req, res) => {
    const parsed = flagPatchBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const pool = getPgPool();
    const upd = await pool.query(
      `UPDATE compliance_flags SET status = $1 WHERE id = $2`,
      [parsed.data.status, req.params.id],
    );
    if ((upd.rowCount ?? 0) === 0) {
      return res.status(404).json({ error: 'Flag not found' });
    }
    const rowQ = await pool.query(
      `SELECT * FROM compliance_flags WHERE id = $1`,
      [req.params.id],
    );
    return res.json({ flag: toComplianceFlag(rowQ.rows[0]) });
  },
);

adminRouterPg.get(
  '/admin/compliance/flags',
  requireAuth,
  requireRoles('admin'),
  async (_req, res) => {
    const pool = getPgPool();
    const r = await pool.query(
      `SELECT * FROM compliance_flags ORDER BY created_at DESC LIMIT 500`,
    );
    return res.json({ flags: r.rows.map(toComplianceFlag) });
  },
);

type AdminClaimRow = {
  id: string;
  policy_id: string;
  merchant_id: string;
  type: string;
  description: string;
  claimed_amount: number;
  status: string;
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  admin_note: string | null;
  business_name: string | null;
  merchant_user_id: string | null;
};

function toAdminInsuranceClaim(row: AdminClaimRow) {
  return {
    id: row.id,
    policyId: row.policy_id,
    merchantId: row.merchant_id,
    merchantBusinessName: row.business_name ?? undefined,
    merchantUserId: row.merchant_user_id ?? undefined,
    type: row.type,
    description: row.description,
    claimedAmount: row.claimed_amount,
    status: row.status,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at ?? undefined,
    reviewedBy: row.reviewed_by ?? undefined,
    adminNote: row.admin_note ?? undefined,
  };
}

const CLAIM_TRANSITIONS: Record<string, string[]> = {
  submitted: ['approved', 'rejected'],
  approved: ['paid'],
  rejected: [],
  paid: [],
};

adminRouterPg.get(
  '/admin/insurance/claims',
  requireAuth,
  requireRoles('admin'),
  async (req, res) => {
    const parsed = adminClaimListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const pool = getPgPool();
    const r = parsed.data.status
      ? await pool.query<AdminClaimRow>(
          `SELECT c.*, m.business_name, m.user_id AS merchant_user_id
             FROM insurance_claims c
             LEFT JOIN merchants m ON m.id = c.merchant_id
            WHERE c.status = $1
            ORDER BY c.created_at DESC
            LIMIT $2`,
          [parsed.data.status, parsed.data.limit],
        )
      : await pool.query<AdminClaimRow>(
          `SELECT c.*, m.business_name, m.user_id AS merchant_user_id
             FROM insurance_claims c
             LEFT JOIN merchants m ON m.id = c.merchant_id
            ORDER BY c.created_at DESC
            LIMIT $1`,
          [parsed.data.limit],
        );
    return res.json({ claims: r.rows.map(toAdminInsuranceClaim) });
  },
);

adminRouterPg.patch(
  '/admin/insurance/claims/:id',
  requireAuth,
  requireRoles('admin'),
  async (req, res) => {
    const parsed = adminClaimPatchBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const pool = getPgPool();
    const existingQ = await pool.query<AdminClaimRow>(
      `SELECT * FROM insurance_claims WHERE id = $1`,
      [req.params.id],
    );
    const existing = existingQ.rows[0];
    if (!existing) {
      return res.status(404).json({ error: 'Claim not found' });
    }
    const allowed = CLAIM_TRANSITIONS[existing.status] ?? [];
    if (!allowed.includes(parsed.data.status)) {
      return res.status(409).json({
        error: `Cannot move claim from "${existing.status}" to "${parsed.data.status}".`,
      });
    }
    const now = new Date().toISOString();
    await pool.query(
      `UPDATE insurance_claims
          SET status = $1,
              reviewed_at = $2,
              reviewed_by = $3,
              admin_note = COALESCE($4, admin_note)
        WHERE id = $5`,
      [
        parsed.data.status,
        now,
        req.auth!.userId,
        parsed.data.adminNote?.trim() ?? null,
        req.params.id,
      ],
    );
    const rowQ = await pool.query<AdminClaimRow>(
      `SELECT c.*, m.business_name, m.user_id AS merchant_user_id
         FROM insurance_claims c
         LEFT JOIN merchants m ON m.id = c.merchant_id
        WHERE c.id = $1`,
      [req.params.id],
    );
    const row = rowQ.rows[0];
    await recordAuditEventPg(pool, {
      type: 'admin.claim_review',
      message: `Claim ${row.id} (${row.type}, R${row.claimed_amount.toFixed(2)}) -> ${parsed.data.status}`,
      actorUserId: req.auth!.userId,
    });
    return res.json({ claim: toAdminInsuranceClaim(row) });
  },
);

adminRouterPg.get(
  '/admin/audit-events',
  requireAuth,
  requireRoles('admin'),
  async (_req, res) => {
    const pool = getPgPool();
    const r = await pool.query<{
      id: string;
      type: string;
      message: string;
      actor_user_id: string | null;
      created_at: string;
    }>(
      `SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 1000`,
    );
    return res.json({
      events: r.rows.map((row) => ({
        id: row.id,
        type: row.type,
        message: row.message,
        actorUserId: row.actor_user_id ?? undefined,
        createdAt: row.created_at,
      })),
    });
  },
);

type ReconRow = {
  wallet_id: string;
  user_id: string;
  pool_id: string;
  wallet_kind: string;
  balance: number;
  ledger_credits: number;
  ledger_debits: number;
  ledger_balance: number;
};

adminRouterPg.post(
  '/admin/reconciliation/run',
  requireAuth,
  requireRoles('admin'),
  async (_req, res) => {
    const pool = getPgPool();
    const r = await pool.query<ReconRow>(
      `
      WITH ledger AS (
        SELECT account_id AS wallet_id,
               SUM(CASE WHEN entry_type = 'credit' THEN amount ELSE 0 END) AS credits,
               SUM(CASE WHEN entry_type = 'debit'  THEN amount ELSE 0 END) AS debits
        FROM ledger_entries
        GROUP BY account_id
      )
      SELECT w.id AS wallet_id,
             w.user_id AS user_id,
             w.pool_id AS pool_id,
             w.wallet_kind AS wallet_kind,
             w.balance AS balance,
             COALESCE(l.credits, 0) AS ledger_credits,
             COALESCE(l.debits, 0)  AS ledger_debits,
             COALESCE(l.credits, 0) - COALESCE(l.debits, 0) AS ledger_balance
        FROM wallets w
        LEFT JOIN ledger l ON l.wallet_id = w.id
      `,
    );

    const tolerance = 0.01;
    const discrepancies = r.rows
      .filter((row) => Math.abs(row.balance - row.ledger_balance) > tolerance)
      .map((row) => ({
        walletId: row.wallet_id,
        userId: row.user_id,
        poolId: row.pool_id,
        kind: row.wallet_kind,
        walletBalance: Number(row.balance.toFixed(2)),
        ledgerBalance: Number(row.ledger_balance.toFixed(2)),
        delta: Number((row.balance - row.ledger_balance).toFixed(2)),
      }));

    return res.json({
      ranAt: new Date().toISOString(),
      walletsChecked: r.rows.length,
      discrepancies,
      ok: discrepancies.length === 0,
    });
  },
);
