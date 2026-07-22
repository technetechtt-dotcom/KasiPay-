import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';

import { getPgPool } from '../dbPg.js';
import { formatCents, parseIntegerCents } from '../money.js';
import { toComplianceFlag, toLoan } from '../extraMappers.js';
import { toMerchant } from '../mappers.js';
import { idempotentPg } from '../middleware/idempotencyPg.js';
import { requireCapability } from '../security/authorization.js';
import { DEFAULT_POOL_ID } from '../poolConstants.js';
import { recordAuditEventPg } from '../services/auditPg.js';
import { getEscrowWalletIdForPoolPg } from '../services/escrowPg.js';
import { postBetweenWalletsPg } from '../services/walletPostingPg.js';
import { MERCHANT_DOC_TYPES } from '../merchantDocuments.js';
import {
  adminClaimListQuerySchema,
  adminClaimPatchBodySchema,
} from '../validation.js';
import { createKycDownloadUrl } from '../services/privateObjectStorage.js';
import { createApprovalRequest, lockApprovedRequest, markApprovalExecuted, requireRecentStepUp } from '../security/approvalsPg.js';

export const adminRouterPg = Router();

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

adminRouterPg.get('/admin/loans', ...requireCapability('loans:read'), async (req, res) => {
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
  amount_cents: string;
  interest_rate: string;
  status: string;
  disbursed_at: string | null;
  due_date: string | null;
  repaid_amount_cents: string;
};

adminRouterPg.patch(
  '/admin/loans/:id/disburse',
  ...requireCapability('loans:request-disbursement'),
  requireRecentStepUp,
  async (req, res) => {
    const pool = getPgPool();
    const approvalRequestId =
      typeof req.body?.approvalRequestId === 'string'
        ? req.body.approvalRequestId
        : null;
    if (!approvalRequestId) {
      const approvalId = await createApprovalRequest({
        actionType: 'loan_disbursement',
        resourceType: 'loan',
        resourceId: req.params.id,
        payload: { loanId: req.params.id },
        reason: typeof req.body?.reason === 'string' ? req.body.reason : '',
        evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : [],
        makerOperatorId: req.opsAuth!.operatorId,
      });
      return res.status(202).json({ approvalId, state: 'pending' });
    }
    const approval = await pool.query<{
      state: string;
      action_type: string;
      resource_id: string;
      maker_operator_id: string;
      checker_operator_id: string | null;
      expires_at: Date;
    }>(
      `SELECT state, action_type, resource_id, maker_operator_id,
              checker_operator_id, expires_at
         FROM approval_requests WHERE id = $1`,
      [approvalRequestId],
    );
    const approved = approval.rows[0];
    if (
      !approved ||
      approved.state !== 'approved' ||
      approved.action_type !== 'loan_disbursement' ||
      approved.resource_id !== req.params.id ||
      !approved.checker_operator_id ||
      approved.maker_operator_id === approved.checker_operator_id ||
      approved.expires_at.getTime() <= Date.now()
    ) {
      return res.status(409).json({ error: 'A valid two-person approval is required.' });
    }
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
      await lockApprovedRequest(client, {
        approvalRequestId,
        actionType: 'loan_disbursement',
        resourceType: 'loan',
        resourceId: req.params.id,
        executorOperatorId: req.opsAuth!.operatorId,
      });
      await postBetweenWalletsPg(client, {
        fromWalletId: escrowId,
        toWalletId: userWallet.id,
        amountCents: parseIntegerCents(row.amount_cents),
        type: 'loan_disbursement',
        referencePrefix: 'LOAN',
        description: `Loan disbursement (${row.interest_rate} fractional rate)`,
      });
      await client.query(
        `UPDATE loans SET status = 'disbursed', disbursed_at = $1 WHERE id = $2`,
        [new Date().toISOString(), row.id],
      );
      await markApprovalExecuted(
        client,
        approvalRequestId,
        req.opsAuth!.operatorId,
        'Approved loan disbursement executed',
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      const msg = e instanceof Error ? e.message : 'Disbursement failed';
      return res.status((e as { status?: number }).status ?? 500).json({ error: msg });
    } finally {
      client.release();
    }
    await recordAuditEventPg(pool, {
      type: 'admin.loan_disburse',
      message: `Loan ${row.id} disbursed R${formatCents(parseIntegerCents(row.amount_cents))} by ${actorLabel(req)}`,
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
  ...requireCapability('compliance:write'),
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
  ...requireCapability('compliance:read'),
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
  claimed_amount_cents: string;
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
    claimedAmount: formatCents(parseIntegerCents(row.claimed_amount_cents)),
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
    ...requireCapability('finance:approve'),
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
  ...requireCapability('finance:approve'),
  requireRecentStepUp,
  idempotentPg('PATCH /admin/insurance/claims/:id'),
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

    let approvalRequestId: string | null =
      typeof req.body?.approvalRequestId === 'string'
        ? req.body.approvalRequestId
        : null;
    if (parsed.data.status === 'paid') {
      if (!req.opsAuth) {
        return res.status(403).json({
          error: 'Insurance payouts require an operator session with maker-checker approval.',
          code: 'OPS_REQUIRED',
        });
      }
      if (!approvalRequestId) {
        const approvalId = await createApprovalRequest({
          actionType: 'insurance_claim_payout',
          resourceType: 'insurance_claim',
          resourceId: req.params.id,
          payload: {
            claimId: req.params.id,
            amountCents: existing.claimed_amount_cents,
          },
          reason:
            typeof req.body?.reason === 'string' && req.body.reason.trim().length >= 10
              ? req.body.reason
              : `Pay insurance claim ${req.params.id}`,
          evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : [],
          makerOperatorId: req.opsAuth.operatorId,
        });
        return res.status(202).json({ approvalId, state: 'pending' });
      }
    }

    const now = new Date().toISOString();
    const reviewer = appActorUserId(req);
    const noteParts = [
      parsed.data.adminNote?.trim() || null,
      req.opsAuth ? `Reviewed by ${actorLabel(req)}` : null,
    ].filter(Boolean);
    const adminNote =
      noteParts.length > 0 ? noteParts.join(' — ') : null;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<AdminClaimRow>(
        `SELECT * FROM insurance_claims WHERE id = $1 FOR UPDATE`,
        [req.params.id],
      );
      const lockedClaim = locked.rows[0];
      if (
        !lockedClaim ||
        !(CLAIM_TRANSITIONS[lockedClaim.status] ?? []).includes(parsed.data.status)
      ) {
        throw Object.assign(new Error('Claim state changed; reload and retry.'), {
          status: 409,
        });
      }
      if (parsed.data.status === 'paid') {
        if (!approvalRequestId || !req.opsAuth) {
          throw Object.assign(new Error('A valid two-person approval is required.'), {
            status: 409,
          });
        }
        await lockApprovedRequest(client, {
          approvalRequestId,
          actionType: 'insurance_claim_payout',
          resourceType: 'insurance_claim',
          resourceId: req.params.id,
          executorOperatorId: req.opsAuth.operatorId,
        });
        const merchantWallet = await client.query<{
          id: string;
          pool_id: string | null;
        }>(
          `SELECT w.id, w.pool_id
             FROM merchants m JOIN wallets w ON w.user_id = m.user_id
            WHERE m.id = $1 AND COALESCE(w.wallet_kind, 'user') = 'user'`,
          [lockedClaim.merchant_id],
        );
        const destination = merchantWallet.rows[0];
        if (!destination) {
          throw Object.assign(new Error('Merchant wallet missing'), { status: 409 });
        }
        const escrowId = await getEscrowWalletIdForPoolPg(
          client,
          destination.pool_id ?? DEFAULT_POOL_ID,
        );
        if (!escrowId) {
          throw Object.assign(new Error('Insurance settlement wallet missing'), {
            status: 503,
          });
        }
        await postBetweenWalletsPg(client, {
          fromWalletId: escrowId,
          toWalletId: destination.id,
          amountCents: parseIntegerCents(lockedClaim.claimed_amount_cents),
          type: 'insurance_payout',
          referencePrefix: 'INS',
          description: `Insurance claim payout ${lockedClaim.id}`,
          actorId: actorLabel(req),
        });
        await markApprovalExecuted(
          client,
          approvalRequestId,
          req.opsAuth.operatorId,
          'Insurance claim payout executed',
        );
      }
      await client.query(
        `UPDATE insurance_claims
            SET status = $1, reviewed_at = $2,
                reviewed_by = COALESCE($3, reviewed_by),
                admin_note = COALESCE($4, admin_note)
          WHERE id = $5`,
        [parsed.data.status, now, reviewer, adminNote, req.params.id],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      const status = (error as { status?: number }).status ?? 500;
      return res.status(status).json({
        error: error instanceof Error ? error.message : 'Claim update failed',
        code: (error as { code?: string }).code,
      });
    } finally {
      client.release();
    }
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
      message: `Claim ${row.id} (${row.type}, R${formatCents(parseIntegerCents(row.claimed_amount_cents))}) -> ${parsed.data.status} by ${actorLabel(req)}`,
      actorUserId: reviewer,
    });
    return res.json({ claim: toAdminInsuranceClaim(row) });
  },
);

adminRouterPg.get(
  '/admin/audit-events',
  ...requireCapability('audit:read'),
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
  balance_cents: string;
  ledger_credits_cents: string;
  ledger_debits_cents: string;
  ledger_balance_cents: string;
};

adminRouterPg.post('/admin/reconciliation/run', ...requireCapability('reconciliation:run'), async (_req, res) => {
    const pool = getPgPool();
    const r = await pool.query<ReconRow>(
      `
      WITH ledger AS (
        SELECT account_id AS wallet_id,
               SUM(CASE WHEN entry_type = 'credit' THEN amount_cents ELSE 0 END) AS credits,
               SUM(CASE WHEN entry_type = 'debit'  THEN amount_cents ELSE 0 END) AS debits
        FROM ledger_entries
        GROUP BY account_id
      )
      SELECT w.id AS wallet_id,
             w.user_id AS user_id,
             w.pool_id AS pool_id,
             w.wallet_kind AS wallet_kind,
             w.balance_cents AS balance_cents,
             COALESCE(l.credits, 0) AS ledger_credits_cents,
             COALESCE(l.debits, 0)  AS ledger_debits_cents,
             COALESCE(l.credits, 0) - COALESCE(l.debits, 0) AS ledger_balance_cents
        FROM wallets w
        LEFT JOIN ledger l ON l.wallet_id = w.id
      `,
    );

    const discrepancies = r.rows
      .filter(
        (row) =>
          parseIntegerCents(row.balance_cents, { allowZero: true }) !==
          parseIntegerCents(row.ledger_balance_cents, {
            allowZero: true,
            allowNegative: true,
          }),
      )
      .map((row) => {
        const wallet = parseIntegerCents(row.balance_cents, { allowZero: true });
        const ledger = parseIntegerCents(row.ledger_balance_cents, {
          allowZero: true,
          allowNegative: true,
        });
        return {
          walletId: row.wallet_id,
          userId: row.user_id,
          poolId: row.pool_id,
          kind: row.wallet_kind,
          walletBalance: formatCents(wallet),
          ledgerBalance: formatCents(ledger),
          delta: formatCents(wallet - ledger),
        };
      });

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

adminRouterPg.get('/admin/merchants', ...requireCapability('merchants:read'), async (req, res) => {
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

adminRouterPg.get('/admin/merchants/:id', ...requireCapability('merchants:read'), async (req, res) => {
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
    id: string;
    doc_type: string;
    file_name: string;
    content_type: string;
    size_bytes: number;
    uploaded_at: string | Date;
  }>(
    `SELECT id, doc_type, file_name, content_type, size_bytes, uploaded_at
       FROM merchant_documents
      WHERE merchant_id = $1
      ORDER BY doc_type`,
    [row.id],
  );
  if (req.opsAuth && docs.rows.length > 0) {
    await pool.query(
      `INSERT INTO kyc_document_audit (id, document_id, operator_id, action, reason)
       SELECT gen_random_uuid(), id, $2, 'metadata_read', 'Merchant KYC case review'
         FROM merchant_documents WHERE merchant_id = $1 AND deleted_at IS NULL`,
      [row.id, req.opsAuth.operatorId],
    );
  }

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
  ...requireCapability('kyc:download'),
  async (req, res) => {
    const pool = getPgPool();
    if (req.opsAuth!.role !== 'admin') {
      const assignment = await pool.query(
        `SELECT 1 FROM kyc_cases
          WHERE merchant_id = $1 AND assigned_operator_id = $2
            AND state IN ('assigned','in_review')`,
        [req.params.id, req.opsAuth!.operatorId],
      );
      if (!assignment.rowCount) {
        return res.status(403).json({ error: 'KYC case is not assigned to this operator.' });
      }
    }
    const r = await pool.query<{
      id: string;
      file_name: string;
      content_type: string;
      object_key: string | null;
      scan_state: string;
    }>(
      `SELECT id, file_name, content_type, object_key, scan_state
         FROM merchant_documents
        WHERE merchant_id = $1 AND doc_type = $2 AND deleted_at IS NULL`,
      [req.params.id, req.params.docType],
    );
    const row = r.rows[0];
    if (!row) return res.status(404).json({ error: 'Document not found' });
    if (!row.object_key || row.scan_state !== 'clean') {
      return res.status(409).json({ error: 'Document is unavailable until a clean malware scan completes.' });
    }
    await pool.query(
      `INSERT INTO kyc_document_audit
        (id, document_id, operator_id, action, reason)
       VALUES ($1,$2,$3,'download_url_issued','Operator requested KYC evidence')`,
      [randomUUID(), row.id, req.opsAuth!.operatorId],
    );
    return res.json({
      fileName: row.file_name,
      contentType: row.content_type,
      download: createKycDownloadUrl(row.object_key),
    });
  },
);

const merchantApprovalBody = z.object({
  status: z.enum(['approved', 'rejected']),
  reason: z.string().trim().max(500).optional(),
});

adminRouterPg.put(
  '/admin/merchants/:id/kyc-assignment',
  ...requireCapability('kyc:assign'),
  async (req, res) => {
    const parsed = z.object({ operatorId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const eligible = await getPgPool().query(
      `SELECT 1 FROM ops_admin_users
        WHERE id = $1 AND is_active = TRUE AND role IN ('admin','compliance')`,
      [parsed.data.operatorId],
    );
    if (!eligible.rowCount) return res.status(400).json({ error: 'Assignee lacks KYC capability.' });
    await getPgPool().query(
      `INSERT INTO kyc_cases (id, merchant_id, assigned_operator_id, state)
       VALUES ($1,$2,$3,'assigned')
       ON CONFLICT (merchant_id) DO UPDATE SET
         assigned_operator_id=EXCLUDED.assigned_operator_id,
         state='assigned', updated_at=NOW()`,
      [randomUUID(), req.params.id, parsed.data.operatorId],
    );
    return res.json({ ok: true });
  },
);

adminRouterPg.patch(
  '/admin/merchants/:id/approval',
  ...requireCapability('merchants:review'),
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

    if (parsed.data.status === 'approved') {
      const docsQ = await pool.query<{ doc_type: string; scan_state: string }>(
        `SELECT doc_type, scan_state
           FROM merchant_documents
          WHERE merchant_id = $1 AND deleted_at IS NULL`,
        [existing.id],
      );
      const cleanByType = new Map(
        docsQ.rows
          .filter((r) => r.scan_state === 'clean')
          .map((r) => [r.doc_type, r]),
      );
      const missing = MERCHANT_DOC_TYPES.filter((t) => !cleanByType.has(t));
      if (missing.length > 0) {
        const presentButNotClean = docsQ.rows
          .filter((r) => MERCHANT_DOC_TYPES.includes(r.doc_type as (typeof MERCHANT_DOC_TYPES)[number]) && r.scan_state !== 'clean')
          .map((r) => ({ docType: r.doc_type, scanState: r.scan_state }));
        return res.status(400).json({
          error:
            'Merchant must have all required KYC documents present, malware-scanned clean, and not deleted before approval.',
          missingDocuments: missing,
          uncleanDocuments: presentButNotClean,
          code: 'KYC_DOCS_NOT_CLEAN',
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
