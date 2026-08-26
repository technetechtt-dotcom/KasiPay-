import { Router } from 'express';
import { z } from 'zod';

import { getPgPool } from '../dbPg.js';
import { idempotentPg } from '../middleware/idempotencyPg.js';
import { parseZarToCents } from '../money.js';
import { requireCapability } from '../security/authorization.js';
import { ingestBankDepositPg } from '../services/bankDepositMatchingPg.js';
import { creditMatchedFloatTopupPg } from '../services/merchantFloatPg.js';
import { listPayoutAgentsPg, setPayoutAgentStatusPg } from '../services/payoutAgentsPg.js';
import { generateSafeguardingReportPg, importSafeguardingBankBalancePg, signOffSafeguardingReportPg } from '../services/safeguardingPg.js';
import { createNetSettlementBatchPg } from '../services/settlementNettingPg.js';
import {
  listBankTransactionHistoryPg,
  reverseBankTransactionPg,
  settleBankTransactionPg,
} from '../services/bankTransactionLifecyclePg.js';
import { applyFloatAdjustmentPg, freezeMerchantFloatPg } from '../services/merchantFloatPg.js';

export const paymentOpsRouterPg = Router();

paymentOpsRouterPg.get(
  '/ops/payments',
  ...requireCapability('finance:approve'),
  async (_req, res) => {
    const rows = await getPgPool().query(
      `SELECT id, product, rail, state, amount_cents, currency, financial_reference, created_at
         FROM payment_intents ORDER BY created_at DESC LIMIT 200`,
    );
    const journals = await getPgPool().query(
      `SELECT j.id, j.reference, j.transaction_type, j.state, j.currency, j.pool_id,
              j.effective_at, j.posted_at,
              COALESCE(SUM(e.amount_cents) FILTER (WHERE e.side = 'debit'), 0)::text AS debit_cents,
              COALESCE(SUM(e.amount_cents) FILTER (WHERE e.side = 'credit'), 0)::text AS credit_cents
         FROM journal_transactions j
         JOIN journal_entries e ON e.transaction_id = j.id
        WHERE j.transaction_type IN (
          'payment','refund','reversal','cash_send_hold','cash_send_collect',
          'cash_send_cancel_refund','cash_send_expire_refund','float_topup',
          'p2p_transfer','transfer','balance_adjustment'
        )
        GROUP BY j.id
        ORDER BY j.effective_at DESC NULLS LAST
        LIMIT 200`,
    );
    return res.json({
      source: 'journal_transactions',
      intentScope: 'orchestrated_external_rails_only',
      journals: journals.rows,
      orchestrated: rows.rows,
      payments: rows.rows,
    });
  },
);

paymentOpsRouterPg.get(
  '/ops/payments/unknown',
  ...requireCapability('finance:approve'),
  async (_req, res) => {
    const rows = await getPgPool().query(
      `SELECT id, product, rail, state, financial_reference, created_at
         FROM payment_intents WHERE state = 'unknown' ORDER BY created_at DESC LIMIT 200`,
    );
    return res.json({ payments: rows.rows });
  },
);

paymentOpsRouterPg.get(
  '/ops/merchant-float',
  ...requireCapability('finance:approve'),
  async (_req, res) => {
    const pool = getPgPool();
    const wallets = await pool.query(
      `SELECT w.user_id, w.id, w.balance_cents, w.currency, w.status
         FROM wallets w WHERE w.wallet_kind = 'merchant_float' ORDER BY w.user_id`,
    );
    const topups = await pool.query(
      `SELECT id, merchant_user_id, amount_cents, merchant_reference, state, created_at
         FROM merchant_float_topups ORDER BY created_at DESC LIMIT 200`,
    );
    return res.json({ wallets: wallets.rows, topups: topups.rows });
  },
);

paymentOpsRouterPg.get(
  '/ops/payout-agents',
  ...requireCapability('merchants:read'),
  async (_req, res) => {
    return res.json({ agents: await listPayoutAgentsPg(getPgPool()) });
  },
);

function agentAction(status: 'enrolled' | 'rejected' | 'suspended') {
  return async (req: import('express').Request, res: import('express').Response) => {
    try {
      await setPayoutAgentStatusPg(
        getPgPool(),
        String(req.params.id),
        status,
        req.opsAuth!.operatorId,
        typeof req.body?.reason === 'string' ? req.body.reason : undefined,
      );
      return res.json({ status });
    } catch (e) {
      const err = e as { status?: number; message?: string };
      return res.status(typeof err.status === 'number' ? err.status : 500).json({
        error: err.message ?? 'Payout agent update failed',
      });
    }
  };
}

paymentOpsRouterPg.post(
  '/ops/payout-agents/:id/approve',
  ...requireCapability('merchants:review'),
  agentAction('enrolled'),
);
paymentOpsRouterPg.post(
  '/ops/payout-agents/:id/reject',
  ...requireCapability('merchants:review'),
  agentAction('rejected'),
);
paymentOpsRouterPg.post(
  '/ops/payout-agents/:id/suspend',
  ...requireCapability('merchants:review'),
  agentAction('suspended'),
);
paymentOpsRouterPg.post(
  '/ops/payout-agents/:id/reactivate',
  ...requireCapability('merchants:review'),
  agentAction('enrolled'),
);

paymentOpsRouterPg.get(
  '/ops/cash-send/vouchers',
  ...requireCapability('support:read'),
  async (_req, res) => {
    const rows = await getPgPool().query(
      `SELECT id, reference_number, status, amount_cents, fee_cents, created_at, expires_at
         FROM cash_send_vouchers ORDER BY created_at DESC LIMIT 200`,
    );
    return res.json({ vouchers: rows.rows });
  },
);

paymentOpsRouterPg.get(
  '/ops/settlement/positions',
  ...requireCapability('finance:approve'),
  async (_req, res) => {
    const rows = await getPgPool().query(
      `SELECT * FROM merchant_settlement_positions ORDER BY position_date DESC LIMIT 200`,
    );
    return res.json({ positions: rows.rows });
  },
);

paymentOpsRouterPg.get(
  '/ops/settlement/batches',
  ...requireCapability('finance:approve'),
  async (_req, res) => {
    const rows = await getPgPool().query(
      `SELECT * FROM settlement_batches ORDER BY created_at DESC LIMIT 200`,
    );
    return res.json({ batches: rows.rows });
  },
);

paymentOpsRouterPg.post(
  '/ops/settlement/net-batches',
  ...requireCapability('reconciliation:run'),
  async (req, res) => {
    const parsed = z
      .object({
        positionIds: z.array(z.string().uuid()).min(1),
        provider: z.string().min(2).max(64),
        settlementDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    try {
      const result = await createNetSettlementBatchPg(getPgPool(), parsed.data);
      return res.status(201).json(result);
    } catch (e) {
      const err = e as { status?: number; message?: string };
      return res.status(typeof err.status === 'number' ? err.status : 500).json({
        error: err.message ?? 'Net batch failed',
      });
    }
  },
);

paymentOpsRouterPg.get(
  '/ops/settlement/suspense',
  ...requireCapability('finance:approve'),
  async (_req, res) => {
    const rows = await getPgPool().query(
      `SELECT id, bank_reference, merchant_reference, amount_cents, currency, match_state, created_at
         FROM bank_transactions
        WHERE match_state IN ('unmatched','partial','suspense','duplicate')
        ORDER BY created_at DESC LIMIT 200`,
    );
    return res.json({ cases: rows.rows });
  },
);

paymentOpsRouterPg.post(
  '/ops/bank-deposits',
  ...requireCapability('reconciliation:run'),
  async (req, res) => {
    const parsed = z
      .object({
        bankReference: z.string().min(1).max(128),
        merchantReference: z.string().min(1).max(128).optional(),
        amount: z.union([z.string(), z.number()]),
        currency: z.string().regex(/^[A-Z]{3}$/).default('ZAR'),
        direction: z.enum(['credit', 'debit']).default('credit'),
        valueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        destinationAccount: z.string().min(1).max(256).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const client = await getPgPool().connect();
    try {
      await client.query('BEGIN');
      const ingested = await ingestBankDepositPg(client, {
        bankReference: parsed.data.bankReference,
        merchantReference: parsed.data.merchantReference,
        amountCents: parseZarToCents(parsed.data.amount),
        currency: parsed.data.currency,
        direction: parsed.data.direction,
        valueDate: parsed.data.valueDate,
        destinationAccount: parsed.data.destinationAccount,
      });
      await client.query('COMMIT');
      return res.status(201).json({
        ...ingested,
        notice:
          ingested.matchState === 'matched'
            ? 'Matched to an approved client-funds credit. Float is not available until this bank transaction is settled.'
            : 'Not credited. Debits, non-client-funds destinations, and unmatched rows go to suspense.',
      });
    } catch (e) {
      await client.query('ROLLBACK');
      const err = e as { status?: number; message?: string };
      return res.status(typeof err.status === 'number' ? err.status : 500).json({
        error: err.message ?? 'Bank deposit ingest failed',
      });
    } finally {
      client.release();
    }
  },
);

paymentOpsRouterPg.post(
  '/ops/merchant-float/topups/:id/credit',
  ...requireCapability('finance:approve'),
  idempotentPg('POST /ops/merchant-float/topups/:id/credit'),
  async (req, res) => {
    const client = await getPgPool().connect();
    try {
      await client.query('BEGIN');
      const result = await creditMatchedFloatTopupPg(client, {
        topupId: String(req.params.id),
        actorId: req.opsAuth!.operatorId,
      });
      await client.query('COMMIT');
      return res.json(result);
    } catch (e) {
      await client.query('ROLLBACK');
      const err = e as { status?: number; message?: string; code?: string };
      return res.status(typeof err.status === 'number' ? err.status : 500).json({
        error: err.message ?? 'Float credit failed',
        code: err.code,
      });
    } finally {
      client.release();
    }
  },
);

paymentOpsRouterPg.get(
  '/ops/safeguarding',
  ...requireCapability('finance:approve'),
  async (_req, res) => {
    const latest = await getPgPool().query(
      `SELECT * FROM safeguarding_reconciliations ORDER BY generated_at DESC LIMIT 20`,
    );
    return res.json({ reports: latest.rows });
  },
);

paymentOpsRouterPg.post(
  '/ops/safeguarding/run',
  ...requireCapability('reconciliation:run'),
  async (req, res) => {
    const parsed = z
      .object({
        actualClientFundsCents: z.string().optional(),
        poolId: z.string().optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const report = await generateSafeguardingReportPg(getPgPool(), {
      poolId: parsed.data.poolId,
      actualClientFundsCents: parsed.data.actualClientFundsCents
        ? BigInt(parsed.data.actualClientFundsCents)
        : undefined,
    });
    return res.status(201).json({
      ...report,
      expectedClientFundsCents: report.expectedClientFundsCents.toString(),
      actualClientFundsCents: report.actualClientFundsCents?.toString() ?? null,
      differenceCents: report.differenceCents?.toString() ?? null,
      breakdown: Object.fromEntries(
        Object.entries(report.breakdown).map(([key, value]) => [key, value.toString()]),
      ),
    });
  },
);

paymentOpsRouterPg.get(
  '/ops/commissions/liabilities',
  ...requireCapability('finance:approve'),
  async (_req, res) => {
    const rows = await getPgPool().query(
      `SELECT source_type, source_id, agent_user_id, sum(amount_cents)::text AS net_cents
         FROM commission_postings
        GROUP BY 1,2,3
        HAVING sum(amount_cents) <> 0
        ORDER BY 1 DESC
        LIMIT 200`,
    );
    return res.json({ liabilities: rows.rows });
  },
);

paymentOpsRouterPg.get(
  '/ops/reconciliation/drift',
  ...requireCapability('reconciliation:run'),
  async (_req, res) => {
    const rows = await getPgPool().query(
      `SELECT id, wallet_id, delta_cents, origin, state, created_at
         FROM drift_remediation_proposals
        ORDER BY created_at DESC LIMIT 100`,
    );
    return res.json({
      proposals: rows.rows,
      notice: 'Proposals only. money:remediate-drift is never run automatically.',
    });
  },
);

paymentOpsRouterPg.get(
  '/ops/bank-transactions/:id',
  ...requireCapability('finance:approve'),
  async (req, res) => {
    const history = await listBankTransactionHistoryPg(getPgPool(), String(req.params.id));
    if (!history.transaction) return res.status(404).json({ error: 'Bank transaction not found' });
    return res.json(history);
  },
);

paymentOpsRouterPg.post(
  '/ops/bank-transactions/:id/settle',
  ...requireCapability('finance:approve'),
  async (req, res) => {
    const parsed = z
      .object({ settlementDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })
      .safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const client = await getPgPool().connect();
    try {
      await client.query('BEGIN');
      const result = await settleBankTransactionPg(client, {
        bankTransactionId: String(req.params.id),
        actorId: req.opsAuth!.operatorId,
        settlementDate: parsed.data.settlementDate,
      });
      await client.query('COMMIT');
      return res.json(result);
    } catch (e) {
      await client.query('ROLLBACK');
      const err = e as { status?: number; message?: string; code?: string };
      return res.status(typeof err.status === 'number' ? err.status : 500).json({
        error: err.message ?? 'Settle failed',
        code: err.code,
      });
    } finally {
      client.release();
    }
  },
);

paymentOpsRouterPg.post(
  '/ops/bank-transactions/:id/reverse',
  ...requireCapability('finance:approve'),
  async (req, res) => {
    const parsed = z
      .object({
        reversalReference: z.string().min(1).max(128),
        reason: z.string().min(10).max(2000),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const client = await getPgPool().connect();
    try {
      await client.query('BEGIN');
      const result = await reverseBankTransactionPg(client, {
        bankTransactionId: String(req.params.id),
        actorId: req.opsAuth!.operatorId,
        reversalReference: parsed.data.reversalReference,
        reason: parsed.data.reason,
      });
      await client.query('COMMIT');
      return res.json(result);
    } catch (e) {
      await client.query('ROLLBACK');
      const err = e as { status?: number; message?: string; code?: string };
      return res.status(typeof err.status === 'number' ? err.status : 500).json({
        error: err.message ?? 'Reversal failed',
        code: err.code,
      });
    } finally {
      client.release();
    }
  },
);

paymentOpsRouterPg.post(
  '/ops/merchant-float/:merchantUserId/freeze',
  ...requireCapability('finance:approve'),
  async (req, res) => {
    const reason =
      typeof req.body?.reason === 'string' && req.body.reason.trim().length >= 10
        ? req.body.reason.trim()
        : null;
    if (!reason) return res.status(400).json({ error: 'A freeze reason of at least 10 characters is required' });
    await freezeMerchantFloatPg(getPgPool(), String(req.params.merchantUserId), reason);
    return res.json({ frozen: true });
  },
);

paymentOpsRouterPg.post(
  '/ops/merchant-float/:merchantUserId/adjust',
  ...requireCapability('finance:approve'),
  async (req, res) => {
    const parsed = z
      .object({
        amount: z.union([z.string(), z.number()]),
        reason: z.string().min(10).max(2000),
        approvalRequestId: z.string().uuid(),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const client = await getPgPool().connect();
    try {
      await client.query('BEGIN');
      const result = await applyFloatAdjustmentPg(client, {
        merchantUserId: String(req.params.merchantUserId),
        amountCents: parseZarToCents(parsed.data.amount, { allowNegative: true }),
        reason: parsed.data.reason,
        actorId: req.opsAuth!.operatorId,
        approvalRequestId: parsed.data.approvalRequestId,
      });
      await client.query('COMMIT');
      return res.json(result);
    } catch (e) {
      await client.query('ROLLBACK');
      const err = e as { status?: number; message?: string; code?: string };
      return res.status(typeof err.status === 'number' ? err.status : 500).json({
        error: err.message ?? 'Float adjustment failed',
        code: err.code,
      });
    } finally {
      client.release();
    }
  },
);

paymentOpsRouterPg.post(
  '/ops/safeguarding/bank-balance',
  ...requireCapability('reconciliation:run'),
  async (req, res) => {
    const parsed = z
      .object({
        bankAccountId: z.string().uuid(),
        asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        availableCents: z.string().regex(/^-?\d+$/),
        source: z.string().min(2).max(64),
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const result = await importSafeguardingBankBalancePg(getPgPool(), {
      bankAccountId: parsed.data.bankAccountId,
      asOf: parsed.data.asOf,
      availableCents: BigInt(parsed.data.availableCents),
      source: parsed.data.source,
      importedBy: req.opsAuth!.operatorId,
    });
    return res.status(201).json(result);
  },
);

paymentOpsRouterPg.post(
  '/ops/safeguarding/:reportId/sign-off',
  ...requireCapability('finance:approve'),
  async (req, res) => {
    try {
      const result = await signOffSafeguardingReportPg(getPgPool(), {
        reportId: String(req.params.reportId),
        operatorId: req.opsAuth!.operatorId,
        note: typeof req.body?.note === 'string' ? req.body.note : undefined,
      });
      return res.status(201).json(result);
    } catch (e) {
      const err = e as { status?: number; message?: string };
      return res.status(typeof err.status === 'number' ? err.status : 500).json({
        error: err.message ?? 'Sign-off failed',
      });
    }
  },
);

paymentOpsRouterPg.get(
  '/ops/settlement/statements/:merchantUserId',
  ...requireCapability('finance:approve'),
  async (req, res) => {
    const pool = getPgPool();
    const positions = await pool.query(
      `SELECT * FROM merchant_settlement_positions
        WHERE merchant_user_id = $1
        ORDER BY position_date DESC LIMIT 90`,
      [String(req.params.merchantUserId)],
    );
    const topups = await pool.query(
      `SELECT id, amount_cents, merchant_reference, state, created_at
         FROM merchant_float_topups WHERE merchant_user_id = $1
         ORDER BY created_at DESC LIMIT 90`,
      [String(req.params.merchantUserId)],
    );
    const withdrawals = await pool.query(
      `SELECT id, amount_cents, state, created_at
         FROM merchant_float_withdrawals WHERE merchant_user_id = $1
         ORDER BY created_at DESC LIMIT 90`,
      [String(req.params.merchantUserId)],
    );
    return res.json({
      merchantUserId: String(req.params.merchantUserId),
      positions: positions.rows,
      bankTopups: topups.rows,
      withdrawals: withdrawals.rows,
    });
  },
);

