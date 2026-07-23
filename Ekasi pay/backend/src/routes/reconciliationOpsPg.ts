import { Router } from 'express';
import { z } from 'zod';

import { getPgPool } from '../dbPg.js';
import { recordAuditEventPg, safeAuditHash } from '../services/auditPg.js';
import {
  lockApprovedRequest,
  markApprovalExecuted,
  requireRecentStepUp,
} from '../security/approvalsPg.js';
import { requireCapability } from '../security/authorization.js';
import { alignLegacyLedgerToWalletPg } from '../services/walletLedgerAlignmentPg.js';
import {
  assertDriftProposalUnchangedPg,
  createDriftRemediationProposalsPg,
  enqueueReconciliationJobPg,
  listOpenReconciliationExceptionsPg,
} from '../services/scheduledReconciliationPg.js';

export const reconciliationOpsRouterPg = Router();

const runTypes = z.enum([
  'wallet_ledger',
  'journal',
  'projection',
  'vouchers',
  'fees',
  'commissions',
  'refunds',
  'settlement',
  'provider_instructions',
  'suspense',
  'loans',
  'insurance',
  'full',
]);

/**
 * Ops never runs reconciliation inline (avoids blocking the API event loop).
 * Jobs are queued for `npm run reconcile:worker`.
 */
reconciliationOpsRouterPg.post(
  '/ops/reconciliation/run',
  ...requireCapability('posting-control:manage'),
  requireRecentStepUp,
  async (req, res) => {
    const parsed = z
      .object({ runType: runTypes.default('full') })
      .safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const queued = await enqueueReconciliationJobPg(getPgPool(), {
      runType: parsed.data.runType,
      requestedBy: `ops:${req.opsAuth!.operatorId}`,
    });
    await recordAuditEventPg(getPgPool(), {
      type: 'reconciliation.enqueued',
      message: `Reconciliation job queued (${parsed.data.runType})`,
      actorType: 'operator',
      actorId: req.opsAuth!.operatorId,
      targetType: 'reconciliation_job_request',
      targetId: queued.requestId,
      afterHash: safeAuditHash(queued),
      requestId: req.requestId,
    });
    return res.status(202).json({
      queued: true,
      requestId: queued.requestId,
      runType: parsed.data.runType,
      note: 'Processed by reconcile:worker — not inside the API process.',
    });
  },
);

reconciliationOpsRouterPg.post(
  '/ops/reconciliation/proposals/generate',
  ...requireCapability('balance-adjustments:request'),
  requireRecentStepUp,
  async (req, res) => {
    const pool = getPgPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await createDriftRemediationProposalsPg(
        client,
        req.opsAuth!.operatorId,
      );
      await client.query('COMMIT');
      return res.status(201).json(result);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
);

reconciliationOpsRouterPg.get(
  '/ops/reconciliation/proposals',
  ...requireCapability('fraud:read'),
  async (_req, res) => {
    const rows = await getPgPool().query(
      `SELECT * FROM drift_remediation_proposals
        WHERE state IN ('proposed','approved')
        ORDER BY created_at DESC LIMIT 200`,
    );
    return res.json({ proposals: rows.rows });
  },
);

reconciliationOpsRouterPg.get(
  '/ops/reconciliation/exceptions',
  ...requireCapability('fraud:read'),
  async (_req, res) => {
    const exceptions = await listOpenReconciliationExceptionsPg(getPgPool());
    return res.json({ exceptions });
  },
);

reconciliationOpsRouterPg.get(
  '/ops/reconciliation/alerts',
  ...requireCapability('fraud:read'),
  async (_req, res) => {
    const rows = await getPgPool().query(
      `SELECT * FROM on_call_alerts
        WHERE state = 'open'
        ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
                 created_at ASC
        LIMIT 200`,
    );
    return res.json({ alerts: rows.rows });
  },
);

const resolveBody = z.object({
  state: z.enum(['resolved', 'accepted_risk', 'wont_fix']),
  note: z.string().trim().min(10).max(4000),
  evidence: z.record(z.unknown()).default({}),
});

reconciliationOpsRouterPg.post(
  '/ops/reconciliation/exceptions/:id/resolve',
  ...requireCapability('posting-control:manage'),
  requireRecentStepUp,
  async (req, res) => {
    const parsed = resolveBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const updated = await getPgPool().query(
      `UPDATE reconciliation_exceptions
          SET state = $1, resolution_note = $2, resolution_evidence = $3::jsonb,
              assigned_operator_id = COALESCE(assigned_operator_id, $4),
              resolved_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE id = $5 AND state IN ('open','assigned','in_progress')
        RETURNING id`,
      [
        parsed.data.state,
        parsed.data.note,
        JSON.stringify(parsed.data.evidence),
        req.opsAuth!.operatorId,
        req.params.id,
      ],
    );
    if (!updated.rowCount) {
      return res.status(409).json({ error: 'Exception is not open for resolution.' });
    }
    return res.json({ ok: true });
  },
);

const adjustBody = z.object({
  approvalRequestId: z.string().uuid(),
  proposalId: z.string().uuid(),
  walletId: z.string().min(1),
  reason: z.string().trim().min(15).max(2000),
});

/**
 * Execute an approved balance_adjustment only if the proposal digest still matches
 * live wallet/journal/projection values. Never edits wallet balances directly.
 */
reconciliationOpsRouterPg.post(
  '/ops/ledger/align-wallet',
  ...requireCapability('balance-adjustments:request'),
  requireRecentStepUp,
  async (req, res) => {
    const parsed = adjustBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const pool = getPgPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const proposal = await assertDriftProposalUnchangedPg(
        client,
        parsed.data.proposalId,
      );
      if (proposal.walletId !== parsed.data.walletId) {
        throw Object.assign(new Error('Proposal wallet mismatch.'), {
          status: 409,
          code: 'PROPOSAL_WALLET_MISMATCH',
        });
      }
      await lockApprovedRequest(client, {
        approvalRequestId: parsed.data.approvalRequestId,
        actionType: 'balance_adjustment',
        resourceType: 'wallet',
        resourceId: parsed.data.walletId,
        executorOperatorId: req.opsAuth!.operatorId,
      });
      const approval = await client.query<{
        payload: { walletId?: string; alignTo?: string; proposalId?: string; evidenceDigest?: string };
      }>(`SELECT payload FROM approval_requests WHERE id = $1`, [
        parsed.data.approvalRequestId,
      ]);
      const payload = approval.rows[0]?.payload ?? {};
      if (payload.walletId && payload.walletId !== parsed.data.walletId) {
        throw Object.assign(new Error('Approval payload wallet mismatch.'), {
          status: 409,
          code: 'APPROVAL_PAYLOAD_MISMATCH',
        });
      }
      if (payload.proposalId && payload.proposalId !== parsed.data.proposalId) {
        throw Object.assign(new Error('Approval payload proposal mismatch.'), {
          status: 409,
          code: 'APPROVAL_PAYLOAD_MISMATCH',
        });
      }
      if (
        payload.evidenceDigest &&
        payload.evidenceDigest !== proposal.evidenceDigest
      ) {
        throw Object.assign(new Error('Approval evidence digest mismatch.'), {
          status: 409,
          code: 'PROPOSAL_EVIDENCE_CHANGED',
        });
      }
      if (payload.alignTo && payload.alignTo !== 'wallet') {
        throw Object.assign(new Error('Only alignTo=wallet is supported.'), {
          status: 400,
        });
      }
      const result = await alignLegacyLedgerToWalletPg(client, {
        walletId: parsed.data.walletId,
        approvalReference: parsed.data.approvalRequestId,
        actorId: req.opsAuth!.operatorId,
        reason: parsed.data.reason,
      });
      await client.query(
        `UPDATE drift_remediation_proposals
            SET state = 'executed',
                executed_at = clock_timestamp(),
                execution_reference = $2,
                approval_request_id = $3,
                approved_evidence_digest = $4
          WHERE id = $1`,
        [
          parsed.data.proposalId,
          result.reference,
          parsed.data.approvalRequestId,
          proposal.evidenceDigest,
        ],
      );
      await markApprovalExecuted(
        client,
        parsed.data.approvalRequestId,
        req.opsAuth!.operatorId,
        'Balance adjustment alignment executed',
      );
      await recordAuditEventPg(client, {
        type: 'ledger.balance_adjustment',
        message: `Aligned ledger to wallet ${parsed.data.walletId}`,
        actorType: 'operator',
        actorId: req.opsAuth!.operatorId,
        targetType: 'wallet',
        targetId: parsed.data.walletId,
        afterHash: safeAuditHash({ ...result, proposalId: parsed.data.proposalId }),
        reason: parsed.data.reason,
        requestId: req.requestId,
        financialReference: result.reference || undefined,
      });
      await client.query('COMMIT');
      return res.json({ ok: true, proposalId: parsed.data.proposalId, ...result });
    } catch (error) {
      await client.query('ROLLBACK');
      const status = (error as { status?: number }).status ?? 500;
      if (status < 500) {
        return res.status(status).json({
          error: error instanceof Error ? error.message : 'Adjustment failed',
          code: (error as { code?: string }).code,
          live: (error as { live?: unknown }).live,
          approved: (error as { approved?: unknown }).approved,
        });
      }
      throw error;
    } finally {
      client.release();
    }
  },
);
