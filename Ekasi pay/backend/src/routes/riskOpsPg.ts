import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import { getPgPool } from '../dbPg.js';
import { recordAuditEventPg, safeAuditHash } from '../services/auditPg.js';
import { requireCapability } from '../security/authorization.js';

export const riskOpsRouterPg = Router();

riskOpsRouterPg.get('/admin/risk/cases', ...requireCapability('fraud:read'), async (req, res) => {
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const result = await getPgPool().query(
    `SELECT id, case_number, state, priority, subject_user_id, assigned_operator_id,
            title, safe_summary, resolution, created_at, updated_at, closed_at
       FROM fraud_cases
      WHERE ($1 = '' OR state = $1)
      ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
               created_at ASC
      LIMIT 200`,
    [state],
  );
  return res.json({ cases: result.rows });
});

riskOpsRouterPg.get('/admin/risk/holds', ...requireCapability('fraud:read'), async (_req, res) => {
  const result = await getPgPool().query(
    `SELECT id, financial_reference, reason_code, state, amount_cents, held_at,
            expires_at, decided_at, decided_by, decision_reason
       FROM transaction_holds ORDER BY held_at DESC LIMIT 200`,
  );
  return res.json({ holds: result.rows });
});

const noteBody = z.object({
  note: z.string().trim().min(3).max(10_000),
  evidenceRefs: z.array(z.string().max(500)).max(50).default([]),
});

riskOpsRouterPg.post(
  '/admin/risk/cases/:id/notes',
  ...requireCapability('fraud:investigate'),
  async (req, res) => {
    const parsed = noteBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const pool = getPgPool();
    const client = await pool.connect();
    const noteId = randomUUID();
    try {
      await client.query('BEGIN');
      const found = await client.query(`SELECT id FROM fraud_cases WHERE id = $1 FOR UPDATE`, [req.params.id]);
      if (!found.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Fraud case not found.' });
      }
      await client.query(
        `INSERT INTO fraud_case_notes
           (id, case_id, author_operator_id, note, evidence_refs, request_id)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
        [noteId, req.params.id, req.opsAuth!.operatorId, parsed.data.note, JSON.stringify(parsed.data.evidenceRefs), req.requestId],
      );
      await recordAuditEventPg(client, {
        type: 'fraud.case.note_added',
        message: 'Immutable fraud investigation note added',
        actorType: 'operator',
        actorId: req.opsAuth!.operatorId,
        targetType: 'fraud_case',
        targetId: req.params.id,
        afterHash: safeAuditHash({ noteId, evidenceRefs: parsed.data.evidenceRefs }),
        reason: 'case investigation',
        requestId: req.requestId,
      });
      await client.query('COMMIT');
      return res.status(201).json({ id: noteId });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
);

const holdDecisionBody = z.object({
  decision: z.enum(['released', 'rejected']),
  reason: z.string().trim().min(10).max(2_000),
});

riskOpsRouterPg.post(
  '/admin/risk/holds/:id/decision',
  ...requireCapability('fraud:investigate'),
  async (req, res) => {
    const parsed = holdDecisionBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const pool = getPgPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const changed = await client.query<{ financial_reference: string }>(
        `UPDATE transaction_holds
            SET state = $1, decided_at = clock_timestamp(), decided_by = $2, decision_reason = $3
          WHERE id = $4 AND state = 'held'
          RETURNING financial_reference`,
        [parsed.data.decision, req.opsAuth!.operatorId, parsed.data.reason, req.params.id],
      );
      if (!changed.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Hold is not awaiting a decision.' });
      }
      await recordAuditEventPg(client, {
        type: 'risk.hold.decided',
        message: `Transaction hold ${parsed.data.decision}`,
        actorType: 'operator',
        actorId: req.opsAuth!.operatorId,
        targetType: 'transaction_hold',
        targetId: req.params.id,
        reason: parsed.data.reason,
        requestId: req.requestId,
        financialReference: changed.rows[0].financial_reference,
      });
      await client.query('COMMIT');
      return res.json({ ok: true });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
);

const switchBody = z.object({
  enabled: z.boolean(),
  reason: z.string().trim().min(15).max(2_000),
});

riskOpsRouterPg.post(
  '/admin/controls/financial-posting',
  ...requireCapability('posting-control:manage'),
  async (req, res) => {
    const parsed = switchBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const pool = getPgPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<{ enabled: boolean }>(
        `SELECT enabled FROM operational_controls WHERE control_key = 'financial_posting' FOR UPDATE`,
      );
      const previous = current.rows[0]?.enabled;
      if (previous === undefined) throw new Error('Posting control is missing.');
      await client.query(
        `UPDATE operational_controls
            SET enabled = $1, version = version + 1, reason = $2, changed_by = $3,
                changed_at = clock_timestamp()
          WHERE control_key = 'financial_posting'`,
        [parsed.data.enabled, parsed.data.reason, req.opsAuth!.operatorId],
      );
      await client.query(
        `INSERT INTO operational_control_events
           (id, control_key, previous_enabled, enabled, reason, actor_operator_id, request_id)
         VALUES ($1,'financial_posting',$2,$3,$4,$5,$6)`,
        [randomUUID(), previous, parsed.data.enabled, parsed.data.reason, req.opsAuth!.operatorId, req.requestId],
      );
      await recordAuditEventPg(client, {
        type: 'operational.posting_control_changed',
        message: parsed.data.enabled ? 'Financial posting enabled' : 'Financial posting disabled',
        actorType: 'operator',
        actorId: req.opsAuth!.operatorId,
        targetType: 'operational_control',
        targetId: 'financial_posting',
        beforeHash: safeAuditHash({ enabled: previous }),
        afterHash: safeAuditHash({ enabled: parsed.data.enabled }),
        reason: parsed.data.reason,
        requestId: req.requestId,
      });
      await client.query('COMMIT');
      return res.json({ enabled: parsed.data.enabled });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
);

riskOpsRouterPg.post(
  '/admin/controls/ledger-drift-check',
  ...requireCapability('posting-control:manage'),
  async (req, res) => {
    const { disablePostingOnLedgerDriftPg } = await import('../services/driftPostingGuardPg.js');
    const { inventoryWalletLedgerDriftPg } = await import('../services/walletLedgerAlignmentPg.js');
    const pool = getPgPool();
    const client = await pool.connect();
    try {
      const drifted = await inventoryWalletLedgerDriftPg(client);
      const guard = await disablePostingOnLedgerDriftPg(client);
      await recordAuditEventPg(pool, {
        type: 'operational.ledger_drift_check',
        message: guard.drifted
          ? `Ledger drift detected (${guard.drifted} wallets); posting disabled`
          : 'Ledger drift check clear',
        actorType: 'operator',
        actorId: req.opsAuth!.operatorId,
        targetType: 'operational_control',
        targetId: 'financial_posting',
        afterHash: safeAuditHash({ drifted: guard.drifted }),
        requestId: req.requestId,
      });
      return res.json({
        ok: drifted.length === 0,
        driftedWallets: drifted.length,
        postingDisabled: guard.disabled,
        sample: drifted.slice(0, 20).map((row) => ({
          walletId: row.walletId,
          deltaCents: row.deltaCents.toString(),
          origin: row.origin,
        })),
      });
    } finally {
      client.release();
    }
  },
);
