import { Router } from 'express';
import { z } from 'zod';

import { getDb } from '../db.js';
import { toComplianceFlag, toLoan } from '../extraMappers.js';
import { requireAuth, requireRoles } from '../middleware/requireAuth.js';
import { recordAuditEvent } from '../services/audit.js';
import {
  adminClaimListQuerySchema,
  adminClaimPatchBodySchema,
} from '../validation.js';

export const adminRouter = Router();

/* ------------------------------------------------------------------ */
/* Loan oversight (admin-only listing for disbursement queue)          */
/* ------------------------------------------------------------------ */

const loanListQuery = z.object({
  status: z
    .enum(['pending', 'approved', 'rejected', 'disbursed', 'repaid'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

adminRouter.get(
  '/admin/loans',
  requireAuth,
  requireRoles('admin'),
  (req, res) => {
    const parsed = loanListQuery.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const database = getDb();
    const sql = parsed.data.status
      ? `SELECT * FROM loans WHERE status = ? ORDER BY id DESC LIMIT ?`
      : `SELECT * FROM loans ORDER BY id DESC LIMIT ?`;
    const stmt = database.prepare(sql);
    const rows = (
      parsed.data.status
        ? stmt.all(parsed.data.status, parsed.data.limit)
        : stmt.all(parsed.data.limit)
    ) as {
      id: string;
      user_id: string;
      amount: number;
      interest_rate: number;
      status: string;
      disbursed_at: string | null;
      due_date: string | null;
      repaid_amount: number;
    }[];
    return res.json({ loans: rows.map(toLoan) });
  },
);

/* ------------------------------------------------------------------ */
/* Compliance flag resolution                                          */
/* ------------------------------------------------------------------ */

const flagPatchBody = z.object({
  status: z.enum(['open', 'resolved', 'dismissed']),
});

adminRouter.patch(
  '/admin/compliance/flags/:id',
  requireAuth,
  requireRoles('admin'),
  (req, res) => {
    const parsed = flagPatchBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const database = getDb();
    const r = database
      .prepare('UPDATE compliance_flags SET status = ? WHERE id = ?')
      .run(parsed.data.status, req.params.id);
    if (r.changes === 0) {
      return res.status(404).json({ error: 'Flag not found' });
    }
    const row = database
      .prepare('SELECT * FROM compliance_flags WHERE id = ?')
      .get(req.params.id) as {
      id: string;
      user_id: string;
      transaction_id: string | null;
      reason: string;
      severity: string;
      status: string;
      created_at: string;
    };
    return res.json({ flag: toComplianceFlag(row) });
  },
);

adminRouter.get(
  '/admin/compliance/flags',
  requireAuth,
  requireRoles('admin'),
  (_req, res) => {
    const database = getDb();
    const rows = database
      .prepare(
        `SELECT * FROM compliance_flags ORDER BY datetime(created_at) DESC LIMIT 500`,
      )
      .all() as {
      id: string;
      user_id: string;
      transaction_id: string | null;
      reason: string;
      severity: string;
      status: string;
      created_at: string;
    }[];
    return res.json({ flags: rows.map(toComplianceFlag) });
  },
);

/* ------------------------------------------------------------------ */
/* Insurance claims review (admin pipeline)                            */
/* ------------------------------------------------------------------ */

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

adminRouter.get(
  '/admin/insurance/claims',
  requireAuth,
  requireRoles('admin'),
  (req, res) => {
    const parsed = adminClaimListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const database = getDb();
    const sql = parsed.data.status
      ? `SELECT c.*, m.business_name, m.user_id AS merchant_user_id
           FROM insurance_claims c
           LEFT JOIN merchants m ON m.id = c.merchant_id
          WHERE c.status = ?
          ORDER BY datetime(c.created_at) DESC
          LIMIT ?`
      : `SELECT c.*, m.business_name, m.user_id AS merchant_user_id
           FROM insurance_claims c
           LEFT JOIN merchants m ON m.id = c.merchant_id
          ORDER BY datetime(c.created_at) DESC
          LIMIT ?`;
    const stmt = database.prepare(sql);
    const rows = (
      parsed.data.status
        ? stmt.all(parsed.data.status, parsed.data.limit)
        : stmt.all(parsed.data.limit)
    ) as AdminClaimRow[];
    return res.json({ claims: rows.map(toAdminInsuranceClaim) });
  },
);

adminRouter.patch(
  '/admin/insurance/claims/:id',
  requireAuth,
  requireRoles('admin'),
  (req, res) => {
    const parsed = adminClaimPatchBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const database = getDb();
    const existing = database
      .prepare(`SELECT * FROM insurance_claims WHERE id = ?`)
      .get(req.params.id) as AdminClaimRow | undefined;
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
    database
      .prepare(
        `UPDATE insurance_claims
            SET status = ?,
                reviewed_at = ?,
                reviewed_by = ?,
                admin_note = COALESCE(?, admin_note)
          WHERE id = ?`,
      )
      .run(
        parsed.data.status,
        now,
        req.auth!.userId,
        parsed.data.adminNote?.trim() ?? null,
        req.params.id,
      );
    const row = database
      .prepare(
        `SELECT c.*, m.business_name, m.user_id AS merchant_user_id
           FROM insurance_claims c
           LEFT JOIN merchants m ON m.id = c.merchant_id
          WHERE c.id = ?`,
      )
      .get(req.params.id) as AdminClaimRow;
    recordAuditEvent(database, {
      type: 'admin.claim_review',
      message: `Claim ${row.id} (${row.type}, R${row.claimed_amount.toFixed(2)}) -> ${parsed.data.status}`,
      actorUserId: req.auth!.userId,
    });
    return res.json({ claim: toAdminInsuranceClaim(row) });
  },
);

adminRouter.get(
  '/admin/audit-events',
  requireAuth,
  requireRoles('admin'),
  (_req, res) => {
    const database = getDb();
    const rows = database
      .prepare(
        `SELECT * FROM audit_events ORDER BY datetime(created_at) DESC LIMIT 1000`,
      )
      .all() as {
      id: string;
      type: string;
      message: string;
      actor_user_id: string | null;
      created_at: string;
    }[];
    return res.json({
      events: rows.map((row) => ({
        id: row.id,
        type: row.type,
        message: row.message,
        actorUserId: row.actor_user_id ?? undefined,
        createdAt: row.created_at,
      })),
    });
  },
);

/* ------------------------------------------------------------------ */
/* Reconciliation                                                      */
/* ------------------------------------------------------------------ */

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

/**
 * Re-sum the ledger and compare to each wallet's stored balance. Returns
 * any wallet whose stored balance differs from `credits - debits` by more
 * than 0.01 (rounding tolerance). This is the canonical reconciliation
 * check that backs the admin "Run Reconciliation Check" button.
 */
adminRouter.post(
  '/admin/reconciliation/run',
  requireAuth,
  requireRoles('admin'),
  (_req, res) => {
    const database = getDb();
    const rows = database
      .prepare(
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
      )
      .all() as ReconRow[];

    const tolerance = 0.01;
    const discrepancies = rows
      .filter(
        (r) => Math.abs(r.balance - r.ledger_balance) > tolerance,
      )
      .map((r) => ({
        walletId: r.wallet_id,
        userId: r.user_id,
        poolId: r.pool_id,
        kind: r.wallet_kind,
        walletBalance: Number(r.balance.toFixed(2)),
        ledgerBalance: Number(r.ledger_balance.toFixed(2)),
        delta: Number((r.balance - r.ledger_balance).toFixed(2)),
      }));

    return res.json({
      ranAt: new Date().toISOString(),
      walletsChecked: rows.length,
      discrepancies,
      ok: discrepancies.length === 0,
    });
  },
);
