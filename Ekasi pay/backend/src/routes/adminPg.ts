import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';

import { getPgPool } from '../dbPg.js';
import { toComplianceFlag, toLoan } from '../extraMappers.js';
import { toMerchant } from '../mappers.js';
import { requireAdminOrOps } from '../opsAuth.js';
import { DEFAULT_POOL_ID } from '../poolConstants.js';
import { recordAuditEventPg } from '../services/auditPg.js';
import { getEscrowWalletIdForPoolPg } from '../services/escrowPg.js';
import { postBetweenWalletsPg } from '../services/walletPostingPg.js';
import {
  adminClaimListQuerySchema,
  adminClaimPatchBodySchema,
} from '../validation.js';

export const adminRouterPg = Router();

const gate = [requireAdminOrOps] as const;

/** App-admin user id when present; null for ops (FK to users). */
function appActorUserId(req: Request): string | null {
  return req.auth?.userId ?? null;
}

function actorLabel(req: Request): string {
  if (req.opsAuth) return `ops:${req.opsAuth.username}`;
  return req.auth?.userId ?? 'admin';
}

const loanListQuery = z.object({
  status: z
    .enum(['pending', 'approved', 'rejected', 'disbursed', 'repaid'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

adminRouterPg.get('/admin/loans', ...gate, async (req, res) => {
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
});

type LoanRow = {
  id: string;
  user_id: string;
  amount: number;
  interest_rate: number;
  status: string;
  disbursed_at: string | null;
  due_date: string | null;
  repaid_amount: number;
};

adminRouterPg.patch(
  '/admin/loans/:id/disburse',
  ...gate,
  async (req, res) => {
    const pool = getPgPool();
    const rowQ = await pool.query<LoanRow>(
      `SELECT * FROM loans WHERE id = $1`,
      [req.params.id],
    );
    const row = rowQ.rows[0];
    if (!row) return res.status(404).json({ error: 'Loan not found' });
    if (row.status !== 'pending') {
      return res.status(409).json({ error: `Loan is already ${row.status}` });
    }
    const escrowId = await getEscrowWalletIdForPoolPg(pool, DEFAULT_POOL_ID);
    if (!escrowId) {
      return res.status(500).json({ error: 'Escrow wallet not configured' });
    }
    const userWalletQ = await pool.query<{ id: string }>(
      `SELECT id FROM wallets WHERE user_id = $1`,
      [row.user_id],
    );
    const userWallet = userWalletQ.rows[0];
    if (!userWallet) {
      return res.status(404).json({ error: 'User wallet missing' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await postBetweenWalletsPg(client, {
        fromWalletId: escrowId,
        toWalletId: userWallet.id,
        amount: row.amount,
        type: 'loan_disbursement',
        referencePrefix: 'LOAN',
        description: `Loan disbursement (${(row.interest_rate * 100).toFixed(1)}% rate)`,
      });
      await client.query(
        `UPDATE loans SET status = 'disbursed', disbursed_at = $1 WHERE id = $2`,
        [new Date().toISOString(), row.id],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      const msg = e instanceof Error ? e.message : 'Disbursement failed';
      return res.status(500).json({ error: msg });
    } finally {
      client.release();
    }
    await recordAuditEventPg(pool, {
      type: 'admin.loan_disburse',
      message: `Loan ${row.id} disbursed R${row.amount.toFixed(2)} by ${actorLabel(req)}`,
      actorUserId: appActorUserId(req),
    });
    const freshQ = await pool.query<LoanRow>(
      `SELECT * FROM loans WHERE id = $1`,
      [row.id],
    );
    return res.json({ loan: toLoan(freshQ.rows[0]) });
  },
);

const flagPatchBody = z.object({
  status: z.enum(['open', 'resolved', 'dismissed']),
});

adminRouterPg.patch(
  '/admin/compliance/flags/:id',
  ...gate,
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
    await recordAuditEventPg(pool, {
      type: 'admin.compliance_flag',
      message: `Flag ${req.params.id} -> ${parsed.data.status} by ${actorLabel(req)}`,
      actorUserId: appActorUserId(req),
    });
    const rowQ = await pool.query(
      `SELECT * FROM compliance_flags WHERE id = $1`,
      [req.params.id],
    );
    return res.json({ flag: toComplianceFlag(rowQ.rows[0]) });
  },
);

adminRouterPg.get(
  '/admin/compliance/flags',
  requireAdminOrOps,
  async (req, res) => {
    const status =
      typeof req.query.status === 'string' ? req.query.status : undefined;
    const pool = getPgPool();
    const r = status
      ? await pool.query(
          `SELECT f.*, u.name AS user_name, u.phone AS user_phone
             FROM compliance_flags f
             LEFT JOIN users u ON u.id = f.user_id
            WHERE f.status = $1
            ORDER BY f.created_at DESC
            LIMIT $2`,
          [status, 500],
        )
      : await pool.query(
          `SELECT f.*, u.name AS user_name, u.phone AS user_phone
             FROM compliance_flags f
             LEFT JOIN users u ON u.id = f.user_id
            ORDER BY f.created_at DESC
            LIMIT 500`,
        );
    return res.json({
      flags: r.rows.map((row) => ({
        ...toComplianceFlag(row),
        userName: row.user_name ?? undefined,
        userPhone: row.user_phone ?? undefined,
      })),
    });
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
  ...gate,
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
  ...gate,
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
    const reviewer = appActorUserId(req);
    const noteParts = [
      parsed.data.adminNote?.trim() || null,
      req.opsAuth ? `Reviewed by ${actorLabel(req)}` : null,
    ].filter(Boolean);
    const adminNote =
      noteParts.length > 0 ? noteParts.join(' — ') : null;
    await pool.query(
      `UPDATE insurance_claims
          SET status = $1,
              reviewed_at = $2,
              reviewed_by = COALESCE($3, reviewed_by),
              admin_note = COALESCE($4, admin_note)
        WHERE id = $5`,
      [parsed.data.status, now, reviewer, adminNote, req.params.id],
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
      message: `Claim ${row.id} (${row.type}, R${row.claimed_amount.toFixed(2)}) -> ${parsed.data.status} by ${actorLabel(req)}`,
      actorUserId: reviewer,
    });
    return res.json({ claim: toAdminInsuranceClaim(row) });
  },
);

adminRouterPg.get(
  '/admin/audit-events',
  requireAdminOrOps,
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

adminRouterPg.post('/admin/reconciliation/run', ...gate, async (_req, res) => {
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

type AdminMerchantRow = {
  id: string;
  user_id: string;
  business_name: string;
  location: string;
  category: string;
  approval_status: string;
  rejection_reason: string | null;
  reviewed_at: string | Date | null;
  reviewed_by: string | null;
  docs_submitted_at: string | Date | null;
  owner_name: string | null;
  owner_phone: string | null;
};

const merchantListQuery = z.object({
  status: z
    .enum(['pending_docs', 'pending_approval', 'approved', 'rejected'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

adminRouterPg.get('/admin/merchants', ...gate, async (req, res) => {
  const parsed = merchantListQuery.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const pool = getPgPool();
  const r = parsed.data.status
    ? await pool.query<AdminMerchantRow>(
        `SELECT m.*, u.name AS owner_name, u.phone AS owner_phone
           FROM merchants m
           LEFT JOIN users u ON u.id = m.user_id
          WHERE m.approval_status = $1
          ORDER BY COALESCE(m.docs_submitted_at, m.reviewed_at) DESC NULLS LAST
          LIMIT $2`,
        [parsed.data.status, parsed.data.limit],
      )
    : await pool.query<AdminMerchantRow>(
        `SELECT m.*, u.name AS owner_name, u.phone AS owner_phone
           FROM merchants m
           LEFT JOIN users u ON u.id = m.user_id
          ORDER BY COALESCE(m.docs_submitted_at, m.reviewed_at) DESC NULLS LAST
          LIMIT $1`,
        [parsed.data.limit],
      );

  const merchantIds = r.rows.map((row) => row.id);
  const docCounts = new Map<string, number>();
  if (merchantIds.length > 0) {
    const dq = await pool.query<{ merchant_id: string; c: string }>(
      `SELECT merchant_id, COUNT(*)::text AS c
         FROM merchant_documents
        WHERE merchant_id = ANY($1::text[])
        GROUP BY merchant_id`,
      [merchantIds],
    );
    for (const row of dq.rows) {
      docCounts.set(row.merchant_id, Number(row.c));
    }
  }

  return res.json({
    merchants: r.rows.map((row) => ({
      ...toMerchant(row),
      ownerName: row.owner_name ?? undefined,
      ownerPhone: row.owner_phone ?? undefined,
      documentsUploaded: docCounts.get(row.id) ?? 0,
      documentsRequired: 4,
    })),
  });
});

adminRouterPg.get('/admin/merchants/:id', ...gate, async (req, res) => {
  const pool = getPgPool();
  const r = await pool.query<AdminMerchantRow>(
    `SELECT m.*, u.name AS owner_name, u.phone AS owner_phone
       FROM merchants m
       LEFT JOIN users u ON u.id = m.user_id
      WHERE m.id = $1`,
    [req.params.id],
  );
  const row = r.rows[0];
  if (!row) return res.status(404).json({ error: 'Merchant not found' });

  const docs = await pool.query<{
    doc_type: string;
    file_name: string;
    content_type: string;
    size_bytes: number;
    uploaded_at: string | Date;
  }>(
    `SELECT doc_type, file_name, content_type, size_bytes, uploaded_at
       FROM merchant_documents
      WHERE merchant_id = $1
      ORDER BY doc_type`,
    [row.id],
  );

  return res.json({
    merchant: {
      ...toMerchant(row),
      ownerName: row.owner_name ?? undefined,
      ownerPhone: row.owner_phone ?? undefined,
    },
    documents: docs.rows.map((d) => ({
      docType: d.doc_type,
      fileName: d.file_name,
      contentType: d.content_type,
      sizeBytes: d.size_bytes,
      uploadedAt:
        typeof d.uploaded_at === 'string' ?
          d.uploaded_at
        : d.uploaded_at.toISOString(),
    })),
  });
});

adminRouterPg.get(
  '/admin/merchants/:id/documents/:docType',
  ...gate,
  async (req, res) => {
    const pool = getPgPool();
    const r = await pool.query<{
      file_name: string;
      content_type: string;
      file_data: Buffer;
    }>(
      `SELECT file_name, content_type, file_data
         FROM merchant_documents
        WHERE merchant_id = $1 AND doc_type = $2`,
      [req.params.id, req.params.docType],
    );
    const row = r.rows[0];
    if (!row) return res.status(404).json({ error: 'Document not found' });
    res.setHeader('Content-Type', row.content_type);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${row.file_name.replace(/"/g, '')}"`,
    );
    return res.send(row.file_data);
  },
);

const merchantApprovalBody = z.object({
  status: z.enum(['approved', 'rejected']),
  reason: z.string().trim().max(500).optional(),
});

adminRouterPg.patch(
  '/admin/merchants/:id/approval',
  ...gate,
  async (req, res) => {
    const parsed = merchantApprovalBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    if (parsed.data.status === 'rejected' && !parsed.data.reason?.trim()) {
      return res.status(400).json({ error: 'Rejection reason is required.' });
    }

    const pool = getPgPool();
    const existingQ = await pool.query<AdminMerchantRow>(
      `SELECT m.*, u.name AS owner_name, u.phone AS owner_phone
         FROM merchants m
         LEFT JOIN users u ON u.id = m.user_id
        WHERE m.id = $1`,
      [req.params.id],
    );
    const existing = existingQ.rows[0];
    if (!existing) return res.status(404).json({ error: 'Merchant not found' });

    if (existing.approval_status === 'approved' && parsed.data.status === 'approved') {
      return res.json({
        merchant: {
          ...toMerchant(existing),
          ownerName: existing.owner_name ?? undefined,
          ownerPhone: existing.owner_phone ?? undefined,
        },
      });
    }

    if (
      parsed.data.status === 'approved' &&
      existing.approval_status !== 'pending_approval' &&
      existing.approval_status !== 'rejected'
    ) {
      const docsQ = await pool.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM merchant_documents WHERE merchant_id = $1`,
        [existing.id],
      );
      if (Number(docsQ.rows[0]?.c ?? 0) < 4) {
        return res.status(400).json({
          error: 'Merchant must submit all four compliance documents first.',
        });
      }
    }

    const now = new Date().toISOString();
    const reviewer =
      appActorUserId(req) ??
      (req.opsAuth ? `ops:${req.opsAuth.operatorId}` : null);
    await pool.query(
      `UPDATE merchants
          SET approval_status = $1,
              rejection_reason = $2,
              reviewed_at = $3,
              reviewed_by = $4
        WHERE id = $5`,
      [
        parsed.data.status,
        parsed.data.status === 'rejected' ? parsed.data.reason!.trim() : null,
        now,
        reviewer,
        existing.id,
      ],
    );

    if (parsed.data.status === 'approved') {
      await pool.query(
        `UPDATE users SET kyc_status = 'verified' WHERE id = $1`,
        [existing.user_id],
      );
    } else if (parsed.data.status === 'rejected') {
      await pool.query(
        `UPDATE users SET kyc_status = 'rejected' WHERE id = $1`,
        [existing.user_id],
      );
    }

    await recordAuditEventPg(pool, {
      type: 'admin.merchant_approval',
      message: `Merchant ${existing.business_name} (${existing.id}) -> ${parsed.data.status} by ${actorLabel(req)}`,
      actorUserId: appActorUserId(req),
    });

    const freshQ = await pool.query<AdminMerchantRow>(
      `SELECT m.*, u.name AS owner_name, u.phone AS owner_phone
         FROM merchants m
         LEFT JOIN users u ON u.id = m.user_id
        WHERE m.id = $1`,
      [existing.id],
    );
    const fresh = freshQ.rows[0];
    return res.json({
      merchant: {
        ...toMerchant(fresh),
        ownerName: fresh.owner_name ?? undefined,
        ownerPhone: fresh.owner_phone ?? undefined,
      },
    });
  },
);
