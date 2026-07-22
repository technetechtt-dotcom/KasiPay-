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
  listOpenReconciliationExceptionsPg,
  runScheduledReconciliationPg,
} from '../services/scheduledReconciliationPg.js';

export const reconciliationOpsRouterPg = Router();

reconciliationOpsRouterPg.post(
  '/ops/reconciliation/run',
  ...requireCapability('posting-control:manage'),
  requireRecentStepUp,
  async (req, res) => {
    const parsed = z
      .object({
        runType: z
          .enum(['wallet_ledger', 'money_columns', 'journal', 'vouchers', 'full'])
          .default('full'),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const result = await runScheduledReconciliationPg(getPgPool(), {
      runType: parsed.data.runType,
      triggeredBy: `ops:${req.opsAuth!.operatorId}`,
    });
    await recordAuditEventPg(getPgPool(), {
      type: 'reconciliation.run',
      message: `Reconciliation ${result.ok ? 'passed' : 'failed'}`,
      actorType: 'operator',
      actorId: req.opsAuth!.operatorId,
      targetType: 'reconciliation_run',
      targetId: result.runId,
      afterHash: safeAuditHash(result),
      requestId: req.requestId,
    });
    return res.status(result.ok ? 200 : 409).json(result);
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
  walletId: z.string().min(1),
  reason: z.string().trim().min(15).max(2000),
});

/**
 * Execute an approved balance_adjustment: aligns legacy ledger + projection to
 * wallets.balance_cents via suspense journals — never direct balance edits.
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
      await lockApprovedRequest(client, {
        approvalRequestId: parsed.data.approvalRequestId,
        actionType: 'balance_adjustment',
        resourceType: 'wallet',
        resourceId: parsed.data.walletId,
        executorOperatorId: req.opsAuth!.operatorId,
      });
      const approval = await client.query<{
        payload: { walletId?: string; alignTo?: string };
        reason: string;
      }>(`SELECT payload, reason FROM approval_requests WHERE id = $1`, [
        parsed.data.approvalRequestId,
      ]);
      const payload = approval.rows[0]?.payload ?? {};
      if (payload.walletId && payload.walletId !== parsed.data.walletId) {
        throw Object.assign(new Error('Approval payload wallet mismatch.'), {
          status: 409,
          code: 'APPROVAL_PAYLOAD_MISMATCH',
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
        afterHash: safeAuditHash(result),
        reason: parsed.data.reason,
        requestId: req.requestId,
        financialReference: result.reference || undefined,
      });
      await client.query('COMMIT');
      return res.json({ ok: true, ...result });
    } catch (error) {
      await client.query('ROLLBACK');
      const status = (error as { status?: number }).status ?? 500;
      if (status < 500) {
        return res.status(status).json({
          error: error instanceof Error ? error.message : 'Adjustment failed',
          code: (error as { code?: string }).code,
        });
      }
      throw error;
    } finally {
      client.release();
    }
  },
);
