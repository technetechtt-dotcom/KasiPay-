import { randomUUID } from 'node:crypto';

import { Router, type NextFunction, type Request, type Response } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';

import { getPgPool } from '../dbPg.js';
import {
  requireCapability,
  roleHasCapability,
  type Capability,
} from './authorization.js';
import { requireOpsAuth } from '../opsAuth.js';

export type ControlledAction =
  | 'loan_disbursement'
  | 'loan_write_off'
  | 'balance_adjustment'
  | 'merchant_approval_override'
  | 'refund_reversal'
  | 'user_role_change'
  | 'transaction_limit_change'
  | 'insurance_claim_payout'
  | 'posting_control_enable';

/** Action types that have an execution adapter consuming approved requests. */
export const EXECUTABLE_CONTROLLED_ACTIONS: readonly ControlledAction[] = [
  'loan_disbursement',
  'refund_reversal',
  'user_role_change',
  'insurance_claim_payout',
  'balance_adjustment',
  'posting_control_enable',
] as const;

/**
 * Lock an approved maker-checker request inside the caller's TX before money moves.
 */
export async function lockApprovedRequest(
  database: PoolClient,
  input: {
    approvalRequestId: string;
    actionType: ControlledAction;
    resourceType: string;
    resourceId: string;
    executorOperatorId: string;
  },
): Promise<void> {
  const locked = await database.query<{
    state: string;
    action_type: string;
    resource_type: string;
    resource_id: string;
    maker_operator_id: string;
    checker_operator_id: string | null;
    expires_at: Date;
  }>(
    `SELECT state, action_type, resource_type, resource_id,
            maker_operator_id, checker_operator_id, expires_at
       FROM approval_requests
      WHERE id = $1
      FOR UPDATE`,
    [input.approvalRequestId],
  );
  const row = locked.rows[0];
  if (
    !row ||
    row.state !== 'approved' ||
    row.action_type !== input.actionType ||
    row.resource_type !== input.resourceType ||
    row.resource_id !== input.resourceId ||
    !row.checker_operator_id ||
    row.maker_operator_id === row.checker_operator_id ||
    row.expires_at.getTime() <= Date.now()
  ) {
    throw Object.assign(new Error('A valid two-person approval is required.'), {
      status: 409,
      code: 'APPROVAL_INVALID',
    });
  }
}

export async function markApprovalExecuted(
  database: PoolClient,
  approvalRequestId: string,
  executorOperatorId: string,
  reason = 'Approved action executed',
): Promise<void> {
  const updated = await database.query(
    `UPDATE approval_requests
        SET state = 'executed', executed_at = clock_timestamp()
      WHERE id = $1 AND state = 'approved'
      RETURNING id`,
    [approvalRequestId],
  );
  if (!updated.rowCount) {
    throw Object.assign(new Error('Approval was already used or expired.'), {
      status: 409,
      code: 'APPROVAL_ALREADY_USED',
    });
  }
  await database.query(
    `INSERT INTO approval_request_events
      (id, approval_request_id, from_state, to_state, actor_operator_id, reason)
     VALUES ($1,$2,'approved','executed',$3,$4)`,
    [randomUUID(), approvalRequestId, executorOperatorId, reason],
  );
}

export async function requireRecentStepUp(req: Request, res: Response, next: NextFunction) {
  if (!req.opsAuth) return res.status(401).json({ error: 'Operator authentication required.' });
  const found = await getPgPool().query(
    `SELECT 1 FROM operator_step_up
      WHERE operator_id = $1 AND session_id = $2 AND expires_at > NOW()
        AND consumed_at IS NULL ORDER BY authenticated_at DESC LIMIT 1`,
    [req.opsAuth.operatorId, req.opsAuth.sessionId],
  );
  if (!found.rowCount) {
    return res.status(403).json({ error: 'Recent step-up authentication required.', code: 'STEP_UP_REQUIRED' });
  }
  return next();
}

export async function createApprovalRequest(input: {
  actionType: ControlledAction;
  resourceType: string;
  resourceId: string;
  payload: unknown;
  reason: string;
  evidence?: unknown[];
  makerOperatorId: string;
  expiresMinutes?: number;
}) {
  if (input.reason.trim().length < 10) throw Object.assign(new Error('A meaningful reason is required.'), { status: 400 });
  const id = randomUUID();
  await getPgPool().query(
    `UPDATE approval_requests SET state = 'expired', decided_at = NOW()
      WHERE action_type = $1 AND resource_type = $2 AND resource_id = $3
        AND state IN ('pending','approved') AND expires_at <= NOW()`,
    [input.actionType, input.resourceType, input.resourceId],
  );
  await getPgPool().query(
    `INSERT INTO approval_requests
      (id, action_type, resource_type, resource_id, payload, reason, evidence,
       maker_operator_id, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW() + ($9 * interval '1 minute'))`,
    [
      id, input.actionType, input.resourceType, input.resourceId, input.payload,
      input.reason.trim(), input.evidence ?? [], input.makerOperatorId,
      input.expiresMinutes ?? 30,
    ],
  );
  await getPgPool().query(
    `INSERT INTO approval_request_events
      (id, approval_request_id, from_state, to_state, actor_operator_id, reason, evidence)
     VALUES ($1,$2,NULL,'pending',$3,$4,$5)`,
    [randomUUID(), id, input.makerOperatorId, input.reason.trim(), input.evidence ?? []],
  );
  return id;
}

export const approvalsRouterPg = Router();

const createBody = z.object({
  actionType: z.enum([
    'loan_disbursement',
    'refund_reversal',
    'user_role_change',
    'insurance_claim_payout',
    'balance_adjustment',
    'posting_control_enable',
  ]),
  resourceType: z.string().trim().min(1).max(100),
  resourceId: z.string().trim().min(1).max(200),
  payload: z.record(z.unknown()),
  reason: z.string().trim().min(10).max(2000),
  evidence: z.array(z.unknown()).max(20).default([]),
  expiresMinutes: z.number().int().min(5).max(120).default(30),
});

approvalsRouterPg.post(
  '/ops/approvals',
  requireOpsAuth,
  requireRecentStepUp,
  async (req, res) => {
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const required: Capability =
      parsed.data.actionType === 'user_role_change'
        ? 'user-roles:request'
        : parsed.data.actionType === 'loan_disbursement'
          ? 'loans:request-disbursement'
          : parsed.data.actionType === 'insurance_claim_payout'
            ? 'finance:approve'
            : parsed.data.actionType === 'balance_adjustment'
              ? 'balance-adjustments:request'
              : parsed.data.actionType === 'posting_control_enable'
                ? 'posting-control:manage'
                : 'refunds:request';
    if (!roleHasCapability(req.opsAuth!.role, required)) {
      return res.status(403).json({ error: 'Required maker capability is not assigned.' });
    }
    const approvalId = await createApprovalRequest({
      ...parsed.data,
      makerOperatorId: req.opsAuth!.operatorId,
    });
    return res.status(202).json({ approvalId, state: 'pending' });
  },
);

approvalsRouterPg.get(
  '/ops/approvals',
  ...requireCapability('finance:approve'),
  async (_req, res) => {
    const rows = await getPgPool().query(
      `SELECT * FROM approval_requests ORDER BY created_at DESC LIMIT 500`,
    );
    return res.json({ approvals: rows.rows });
  },
);

const decisionBody = z.object({
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().trim().min(10).max(1000),
  evidence: z.array(z.unknown()).max(20).default([]),
});

approvalsRouterPg.post(
  '/ops/approvals/:id/decision',
  ...requireCapability('finance:approve'),
  requireRecentStepUp,
  async (req, res) => {
    const parsed = decisionBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const client = await getPgPool().connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<{
        state: string; maker_operator_id: string; expires_at: Date;
      }>(`SELECT state, maker_operator_id, expires_at FROM approval_requests WHERE id = $1 FOR UPDATE`, [req.params.id]);
      const row = locked.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Approval request not found.' });
      }
      if (row.maker_operator_id === req.opsAuth!.operatorId) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Maker and checker must be different operators.' });
      }
      if (row.state !== 'pending' || row.expires_at.getTime() <= Date.now()) {
        if (row.state === 'pending') {
          await client.query(`UPDATE approval_requests SET state = 'expired', decided_at = NOW() WHERE id = $1`, [req.params.id]);
        }
        await client.query('COMMIT');
        return res.status(409).json({ error: 'Approval request is no longer pending.' });
      }
      await client.query(
        `UPDATE approval_requests SET state = $1, checker_operator_id = $2,
          decided_at = NOW(), decision_reason = $3 WHERE id = $4`,
        [parsed.data.decision, req.opsAuth!.operatorId, parsed.data.reason, req.params.id],
      );
      await client.query(
        `INSERT INTO approval_request_events
          (id, approval_request_id, from_state, to_state, actor_operator_id, reason, evidence)
         VALUES ($1,$2,'pending',$3,$4,$5,$6)`,
        [randomUUID(), req.params.id, parsed.data.decision, req.opsAuth!.operatorId, parsed.data.reason, parsed.data.evidence],
      );
      await client.query('COMMIT');
      return res.json({ ok: true, state: parsed.data.decision });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
);
