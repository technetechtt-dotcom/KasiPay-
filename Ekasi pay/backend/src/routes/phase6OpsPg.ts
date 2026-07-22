import { createHash, randomUUID } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import { getPgPool } from '../dbPg.js';
import { requireCapability } from '../security/authorization.js';
import {
  importSettlementStatementPg,
  reconcileSettlementFilePg,
} from '../services/settlementPg.js';

export const phase6OpsRouterPg = Router();

const settlementAccountBody = z.object({
  merchantId: z.string().min(1).max(200),
  provider: z.string().min(2).max(64),
  currency: z.string().regex(/^[A-Z]{3}$/),
  accountToken: z.string().min(8).max(500),
  beneficiaryName: z.string().trim().min(2).max(200),
});

phase6OpsRouterPg.post(
  '/ops/settlement/accounts',
  ...requireCapability('finance:approve'),
  async (req, res) => {
    const parsed = settlementAccountBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const id = randomUUID();
    const fingerprint = createHash('sha256')
      .update(`${parsed.data.provider}:${parsed.data.accountToken}`)
      .digest('hex');
    await getPgPool().query(
      `INSERT INTO merchant_settlement_accounts
         (id,merchant_id,currency,provider,account_token,account_fingerprint,
          beneficiary_name,state,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8)`,
      [id, parsed.data.merchantId, parsed.data.currency, parsed.data.provider,
        parsed.data.accountToken, fingerprint, parsed.data.beneficiaryName,
        req.opsAuth!.operatorId],
    );
    return res.status(201).json({ id, fingerprint, state: 'pending' });
  },
);

phase6OpsRouterPg.post(
  '/ops/settlement/accounts/:id/verify',
  ...requireCapability('finance:approve'),
  async (req, res) => {
    const result = await getPgPool().query(
      `UPDATE merchant_settlement_accounts
          SET state = 'verified',verified_at = clock_timestamp(),verified_by = $2
        WHERE id = $1 AND state = 'pending' AND created_by <> $2 RETURNING id`,
      [req.params.id, req.opsAuth!.operatorId],
    );
    if (!result.rowCount) {
      return res.status(409).json({ error: 'Account is not eligible or maker equals checker' });
    }
    return res.json({ state: 'verified' });
  },
);

const batchBody = z.object({
  settlementAccountId: z.string().uuid(),
  feeComponentIds: z.array(z.string().uuid()).min(1).max(500),
  settlementDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

phase6OpsRouterPg.post(
  '/ops/settlement/batches',
  ...requireCapability('reconciliation:run'),
  async (req, res) => {
    const parsed = batchBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const client = await getPgPool().connect();
    const batchId = randomUUID();
    const batchReference = `SET-${batchId.slice(0, 8).toUpperCase()}`;
    try {
      await client.query('BEGIN');
      const account = await client.query<{
        id: string; currency: string; provider: string; user_id: string;
      }>(
        `SELECT a.id,a.currency,a.provider,m.user_id
           FROM merchant_settlement_accounts a
           JOIN merchants m ON m.id = a.merchant_id
          WHERE a.id = $1 AND a.state = 'verified' FOR UPDATE`,
        [parsed.data.settlementAccountId],
      );
      if (!account.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Verified settlement account not found' });
      }
      const components = await client.query<{
        id: string; amount_cents: string; liability_account_id: string;
        beneficiary_user_id: string; currency: string;
      }>(
        `SELECT c.id,c.amount_cents,c.liability_account_id,c.beneficiary_user_id,a.currency
           FROM fee_assessment_components c
           JOIN fee_assessments a ON a.id = c.assessment_id
          WHERE c.id = ANY($1::uuid[]) AND c.amount_cents > 0
            AND c.beneficiary_user_id = $2
            AND NOT EXISTS (SELECT 1 FROM payout_instructions p
                             WHERE p.source_fee_component_id = c.id)
          ORDER BY c.id FOR UPDATE OF c`,
        [parsed.data.feeComponentIds, account.rows[0].user_id],
      );
      if (components.rowCount !== new Set(parsed.data.feeComponentIds).size) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'A component is ineligible, already settled, or belongs to another beneficiary' });
      }
      const total = components.rows.reduce((sum, row) => sum + BigInt(row.amount_cents), 0n);
      await client.query(
        `INSERT INTO settlement_batches
           (id,batch_reference,currency,provider,settlement_date,state,item_count,
            total_cents,maker_operator_id)
         VALUES ($1,$2,$3,$4,$5,'created',$6,$7,$8)`,
        [batchId, batchReference, account.rows[0].currency, account.rows[0].provider,
          parsed.data.settlementDate, components.rowCount, total.toString(),
          req.opsAuth!.operatorId],
      );
      for (const [index, component] of components.rows.entries()) {
        const transactionId = randomUUID();
        const postingBatchId = randomUUID();
        const reference = `${batchReference}-${index + 1}`;
        await client.query(
          `INSERT INTO posting_batches(id,source,actor_id,state)
           VALUES ($1,'fee_settlement',$2,'authorized');
           INSERT INTO journal_transactions
             (id,batch_id,reference,transaction_type,description,currency,pool_id,
              state,effective_at,posted_at)
           VALUES ($3,$1,$4,'fee_settlement',$5,$6,'ZA','authorized',
                   clock_timestamp(),clock_timestamp());
           INSERT INTO journal_entries(id,transaction_id,account_id,side,amount_cents,currency)
           VALUES ($7,$3,$8,'debit',$9,$6),
                  ($10,$3,'phase6-settlement-suspense-zar','credit',$9,$6);
           UPDATE journal_transactions SET state = 'posted' WHERE id = $3;
           UPDATE posting_batches SET state = 'posted',posted_at = clock_timestamp() WHERE id = $1`,
          [postingBatchId, req.opsAuth!.operatorId, transactionId, reference,
            `Fee liability settlement ${component.id}`, component.currency,
            randomUUID(), component.liability_account_id, component.amount_cents,
            randomUUID()],
        );
        await client.query(
          `UPDATE account_balance_projections
              SET available_cents = available_cents - $1,version = version + 1,
                  updated_at = clock_timestamp()
            WHERE account_id IN ($2,'phase6-settlement-suspense-zar')`,
          [component.amount_cents, component.liability_account_id],
        );
        await client.query(
          `INSERT INTO payout_instructions
             (id,batch_id,settlement_account_id,journal_transaction_id,
              amount_cents,currency,state,source_fee_component_id)
           VALUES ($1,$2,$3,$4,$5,$6,'created',$7)`,
          [randomUUID(), batchId, account.rows[0].id, transactionId,
            component.amount_cents, component.currency, component.id],
        );
      }
      await client.query('COMMIT');
      return res.status(201).json({
        id: batchId, batchReference, itemCount: components.rowCount, totalCents: total.toString(),
        state: 'created',
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
);

phase6OpsRouterPg.post(
  '/ops/settlement/batches/:id/approve',
  ...requireCapability('finance:approve'),
  async (req, res) => {
    const result = await getPgPool().query(
      `UPDATE settlement_batches SET state = 'approved',checker_operator_id = $2,
              approved_at = clock_timestamp()
        WHERE id = $1 AND state = 'created' AND maker_operator_id <> $2
        RETURNING id`,
      [req.params.id, req.opsAuth!.operatorId],
    );
    if (!result.rowCount) {
      return res.status(409).json({ error: 'Batch is not eligible or maker equals checker' });
    }
    return res.json({ state: 'approved' });
  },
);

const importBody = z.object({
  provider: z.string().trim().min(2).max(64),
  schemaVersion: z.literal('phase6-v1'),
  fileName: z.string().trim().min(1).max(200),
  contentBase64: z.string().min(1).max(650_000),
});

phase6OpsRouterPg.post(
  '/ops/settlement/statements',
  ...requireCapability('reconciliation:run'),
  async (req, res) => {
    const parsed = importBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const content = Buffer.from(parsed.data.contentBase64, 'base64');
    if (content.length === 0 || content.toString('base64').replace(/=+$/, '') !== parsed.data.contentBase64.replace(/=+$/, '')) {
      return res.status(400).json({ error: 'contentBase64 is not canonical base64' });
    }
    const client = await getPgPool().connect();
    try {
      await client.query('BEGIN');
      const imported = await importSettlementStatementPg(client, {
        ...parsed.data,
        content,
        operatorId: req.opsAuth!.operatorId,
      });
      const matches = await reconcileSettlementFilePg(client, imported.fileId);
      await client.query(
        `INSERT INTO audit_events
           (id,type,message,created_at,actor_type,actor_id,target_type,target_id,
            safe_metadata,reason,request_id,correlation_id)
         VALUES ($1,'settlement.statement.imported',$2,clock_timestamp(),'operator',$3,
                 'settlement_statement_file',$4,$5::jsonb,'finance reconciliation',$6,$7)`,
        [
          randomUUID(),
          `Settlement statement imported and deterministically reconciled`,
          req.opsAuth!.operatorId,
          imported.fileId,
          JSON.stringify({ provider: parsed.data.provider, rowCount: imported.rowCount, matches }),
          req.requestId,
          req.correlationId,
        ],
      );
      await client.query('COMMIT');
      return res.status(201).json({ ...imported, matches });
    } catch (error) {
      await client.query('ROLLBACK');
      if ((error as { code?: string }).code === '23505') {
        return res.status(409).json({ error: 'Duplicate statement file or canonical content' });
      }
      throw error;
    } finally {
      client.release();
    }
  },
);

const resolutionBody = z.object({
  journalTransactionId: z.string().uuid(),
  reason: z.string().trim().min(10).max(1000),
  evidence: z.array(z.unknown()).min(1).max(20),
});

phase6OpsRouterPg.post(
  '/ops/settlement/suspense/:id/propose',
  ...requireCapability('reconciliation:run'),
  async (req, res) => {
    const parsed = resolutionBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const client = await getPgPool().connect();
    try {
      await client.query('BEGIN');
      const changed = await client.query(
        `UPDATE settlement_suspense_cases
            SET state = 'pending_approval',proposed_journal_transaction_id = $2,
                maker_operator_id = $3
          WHERE id = $1 AND state = 'open'
            AND EXISTS (SELECT 1 FROM journal_transactions
                         WHERE id = $2 AND state IN ('posted','settled'))
          RETURNING id`,
        [req.params.id, parsed.data.journalTransactionId, req.opsAuth!.operatorId],
      );
      if (!changed.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Case or proposed journal is not eligible' });
      }
      await client.query(
        `INSERT INTO settlement_suspense_events
           (id,case_id,from_state,to_state,actor_operator_id,reason,evidence)
         VALUES ($1,$2,'open','pending_approval',$3,$4,$5::jsonb)`,
        [randomUUID(), req.params.id, req.opsAuth!.operatorId, parsed.data.reason,
          JSON.stringify(parsed.data.evidence)],
      );
      await client.query('COMMIT');
      return res.status(202).json({ state: 'pending_approval' });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
);

const resolutionDecisionBody = z.object({
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().trim().min(10).max(1000),
  evidence: z.array(z.unknown()).min(1).max(20),
});

phase6OpsRouterPg.post(
  '/ops/settlement/suspense/:id/decision',
  ...requireCapability('finance:approve'),
  async (req, res) => {
    const parsed = resolutionDecisionBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const client = await getPgPool().connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<{
        state: string;
        maker_operator_id: string;
        proposed_journal_transaction_id: string;
        statement_item_id: string;
      }>(
        `SELECT state,maker_operator_id,proposed_journal_transaction_id,statement_item_id
           FROM settlement_suspense_cases WHERE id = $1 FOR UPDATE`,
        [req.params.id],
      );
      const row = locked.rows[0];
      if (!row || row.state !== 'pending_approval') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Resolution is not pending approval' });
      }
      if (row.maker_operator_id === req.opsAuth!.operatorId) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Maker and checker must be different operators' });
      }
      const nextState = parsed.data.decision === 'approved' ? 'resolved' : 'rejected';
      await client.query(
        `UPDATE settlement_suspense_cases
            SET state = $2,checker_operator_id = $3,
                resolved_at = CASE WHEN $2 = 'resolved' THEN clock_timestamp() END
          WHERE id = $1`,
        [req.params.id, nextState, req.opsAuth!.operatorId],
      );
      if (nextState === 'resolved') {
        await client.query(
          `UPDATE settlement_statement_items
              SET match_state = 'resolved',journal_transaction_id = $2 WHERE id = $1`,
          [row.statement_item_id, row.proposed_journal_transaction_id],
        );
      }
      await client.query(
        `INSERT INTO settlement_suspense_events
           (id,case_id,from_state,to_state,actor_operator_id,reason,evidence)
         VALUES ($1,$2,'pending_approval',$3,$4,$5,$6::jsonb)`,
        [randomUUID(), req.params.id, nextState, req.opsAuth!.operatorId,
          parsed.data.reason, JSON.stringify(parsed.data.evidence)],
      );
      await client.query('COMMIT');
      return res.json({ state: nextState });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
);

phase6OpsRouterPg.post(
  '/ops/settlement/daily-closes/:id/sign-off',
  ...requireCapability('finance:approve'),
  async (req, res) => {
    const parsed = z.object({
      reason: z.string().trim().min(10).max(1000),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const result = await getPgPool().query(
      `UPDATE settlement_daily_closes
          SET state = 'signed_off',checker_operator_id = $2,signed_at = clock_timestamp()
        WHERE id = $1 AND state = 'pending_approval'
          AND maker_operator_id <> $2
        RETURNING id`,
      [req.params.id, req.opsAuth!.operatorId],
    );
    if (!result.rowCount) {
      return res.status(409).json({ error: 'Close is not eligible or maker equals checker' });
    }
    await getPgPool().query(
      `INSERT INTO audit_events
         (id,type,message,created_at,actor_type,actor_id,target_type,target_id,
          reason,request_id,correlation_id)
       VALUES ($1,'settlement.daily_close.signed_off','Daily settlement close signed off',
               clock_timestamp(),'operator',$2,'settlement_daily_close',$3,$4,$5,$6)`,
      [randomUUID(), req.opsAuth!.operatorId, req.params.id, parsed.data.reason,
        req.requestId, req.correlationId],
    );
    return res.json({ state: 'signed_off' });
  },
);

phase6OpsRouterPg.get(
  '/ops/settlement/overview',
  ...requireCapability('reconciliation:run'),
  async (_req, res) => {
    const [files, breaks, batches, closes] = await Promise.all([
      getPgPool().query(
        `SELECT id,provider,file_name,row_count,content_sha256,imported_at
           FROM settlement_statement_files ORDER BY imported_at DESC LIMIT 50`,
      ),
      getPgPool().query(
        `SELECT c.id,c.state,c.reason_code,c.opened_at,i.provider_reference,
                i.amount_cents,i.currency,i.match_state,i.journal_transaction_id
           FROM settlement_suspense_cases c
           JOIN settlement_statement_items i ON i.id = c.statement_item_id
          WHERE c.state NOT IN ('resolved','rejected') ORDER BY c.opened_at`,
      ),
      getPgPool().query(
        `SELECT * FROM settlement_batches ORDER BY created_at DESC LIMIT 100`,
      ),
      getPgPool().query(
        `SELECT * FROM settlement_daily_closes ORDER BY close_date DESC LIMIT 31`,
      ),
    ]);
    return res.json({
      files: files.rows,
      breaks: breaks.rows,
      batches: batches.rows,
      closes: closes.rows,
    });
  },
);

const closeBody = z.object({
  closeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  provider: z.string().min(2).max(64),
  currency: z.string().regex(/^[A-Z]{3}$/),
  expectedCents: z.string().regex(/^[0-9]+$/),
  statementCents: z.string().regex(/^[0-9]+$/),
  matchedCents: z.string().regex(/^[0-9]+$/),
  breakCents: z.string().regex(/^-?[0-9]+$/),
  evidence: z.array(z.record(z.unknown())).min(1).max(100),
});

phase6OpsRouterPg.post(
  '/ops/settlement/daily-closes',
  ...requireCapability('reconciliation:run'),
  async (req, res) => {
    const parsed = closeBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const id = randomUUID();
    const evidence = JSON.stringify(parsed.data.evidence);
    await getPgPool().query(
      `INSERT INTO settlement_daily_closes
         (id,close_date,currency,provider,state,expected_cents,statement_cents,
          matched_cents,break_cents,evidence,evidence_sha256,maker_operator_id)
       VALUES ($1,$2,$3,$4,'pending_approval',$5,$6,$7,$8,$9::jsonb,$10,$11)`,
      [
        id,
        parsed.data.closeDate,
        parsed.data.currency,
        parsed.data.provider,
        parsed.data.expectedCents,
        parsed.data.statementCents,
        parsed.data.matchedCents,
        parsed.data.breakCents,
        evidence,
        createHash('sha256').update(evidence).digest('hex'),
        req.opsAuth!.operatorId,
      ],
    );
    return res.status(202).json({ id, state: 'pending_approval' });
  },
);

phase6OpsRouterPg.get(
  '/ops/fees/schedules',
  ...requireCapability('finance:approve'),
  async (_req, res) => {
    const schedules = await getPgPool().query(
      `SELECT s.*, COALESCE(json_agg(t ORDER BY t.min_cents)
        FILTER (WHERE t.id IS NOT NULL),'[]') AS tiers
         FROM fee_schedules s LEFT JOIN fee_schedule_tiers t ON t.fee_schedule_id = s.id
        GROUP BY s.id ORDER BY s.product,s.effective_from DESC`,
    );
    return res.json({ schedules: schedules.rows });
  },
);

const feeScheduleBody = z.object({
  code: z.string().regex(/^[A-Z0-9_-]{3,50}$/),
  version: z.number().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  product: z.string().min(2).max(64),
  effectiveFrom: z.string().datetime(),
  tiers: z.array(z.object({
    minCents: z.string().regex(/^[0-9]+$/),
    maxCents: z.string().regex(/^[0-9]+$/).nullable(),
    flatCents: z.string().regex(/^[0-9]+$/),
    rateBasisPoints: z.number().int().min(0).max(10_000),
    minFeeCents: z.string().regex(/^[0-9]+$/),
    maxFeeCents: z.string().regex(/^[0-9]+$/).nullable(),
    allocations: z.record(z.number().int().min(0).max(10_000)),
  })).min(1).max(100),
});

phase6OpsRouterPg.post(
  '/ops/fees/schedules',
  ...requireCapability('finance:approve'),
  async (req, res) => {
    const parsed = feeScheduleBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    if (parsed.data.tiers.some((tier) =>
      Object.values(tier.allocations).reduce((sum, value) => sum + value, 0) !== 10_000)) {
      return res.status(400).json({ error: 'Each tier allocation must total 10000 basis points' });
    }
    const client = await getPgPool().connect();
    const id = randomUUID();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO fee_schedules
           (id,code,version,currency,product,effective_from,state,maker_operator_id)
         VALUES ($1,$2,$3,$4,$5,$6,'draft',$7)`,
        [id, parsed.data.code, parsed.data.version, parsed.data.currency,
          parsed.data.product, parsed.data.effectiveFrom, req.opsAuth!.operatorId],
      );
      for (const tier of parsed.data.tiers) {
        await client.query(
          `INSERT INTO fee_schedule_tiers
             (id,fee_schedule_id,min_cents,max_cents,flat_cents,rate_basis_points,
              min_fee_cents,max_fee_cents,allocations)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
          [randomUUID(), id, tier.minCents, tier.maxCents, tier.flatCents,
            tier.rateBasisPoints, tier.minFeeCents, tier.maxFeeCents,
            JSON.stringify(tier.allocations)],
        );
      }
      await client.query('COMMIT');
      return res.status(201).json({ id, state: 'draft' });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
);

phase6OpsRouterPg.post(
  '/ops/fees/schedules/:id/publish',
  ...requireCapability('finance:approve'),
  async (req, res) => {
    const parsed = z.object({
      reason: z.string().trim().min(10).max(1000),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const client = await getPgPool().connect();
    try {
      await client.query('BEGIN');
      const schedule = await client.query<{
        maker_operator_id: string;
        product: string;
        currency: string;
        effective_from: string;
        effective_to: string | null;
      }>(`SELECT * FROM fee_schedules WHERE id = $1 AND state = 'draft' FOR UPDATE`, [req.params.id]);
      const row = schedule.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Fee schedule is not a draft' });
      }
      if (row.maker_operator_id === req.opsAuth!.operatorId) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Maker and checker must be different operators' });
      }
      const overlap = await client.query(
        `SELECT 1 FROM fee_schedules
          WHERE product = $1 AND currency = $2 AND state = 'published'
            AND effective_from < COALESCE($4::timestamptz,'infinity'::timestamptz)
            AND COALESCE(effective_to,'infinity'::timestamptz) > $3::timestamptz
          LIMIT 1`,
        [row.product, row.currency, row.effective_from, row.effective_to],
      );
      if (overlap.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Published fee schedule effective dates overlap' });
      }
      await client.query(
        `UPDATE fee_schedules SET state = 'published',checker_operator_id = $2 WHERE id = $1`,
        [req.params.id, req.opsAuth!.operatorId],
      );
      await client.query(
        `INSERT INTO audit_events
           (id,type,message,created_at,actor_type,actor_id,target_type,target_id,reason)
         VALUES ($1,'fee_schedule.published','Versioned fee schedule published',
                 clock_timestamp(),'operator',$2,'fee_schedule',$3,$4)`,
        [randomUUID(), req.opsAuth!.operatorId, req.params.id, parsed.data.reason],
      );
      await client.query('COMMIT');
      return res.json({ state: 'published' });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
);
