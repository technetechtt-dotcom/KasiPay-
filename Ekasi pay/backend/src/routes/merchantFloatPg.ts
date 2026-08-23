import { Router } from 'express';
import { z } from 'zod';

import { getPgPool } from '../dbPg.js';
import { formatCents, parseZarToCents } from '../money.js';
import { idempotentPg } from '../middleware/idempotencyPg.js';
import { requireApprovedMerchant } from '../middleware/requireApprovedMerchant.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireMerchantIdPg } from '../services/merchantPg.js';
import {
  getFloatHistoryPg,
  requestFloatTopupPg,
  requestFloatWithdrawalPg,
} from '../services/merchantFloatPg.js';
import {
  ensureMerchantFloatWalletPg,
  getMerchantFloatWalletPg,
} from '../services/walletKindsPg.js';

export const merchantFloatRouterPg = Router();
merchantFloatRouterPg.use(requireAuth, requireApprovedMerchant);

merchantFloatRouterPg.get('/merchant/float', async (req, res) => {
  const pool = getPgPool();
  const wallet = await ensureMerchantFloatWalletPg(pool, req.auth!.userId);
  return res.json({
    walletId: wallet.id,
    walletKind: wallet.wallet_kind,
    balance: formatCents(BigInt(wallet.balance_cents ?? '0')),
    currency: wallet.currency,
    poolId: wallet.pool_id,
    status: wallet.status,
  });
});

merchantFloatRouterPg.get('/merchant/float/history', async (req, res) => {
  const history = await getFloatHistoryPg(getPgPool(), req.auth!.userId);
  return res.json(history);
});

const amountBody = z.object({
  amount: z.union([z.string(), z.number()]),
});

merchantFloatRouterPg.post(
  '/merchant/float/topups',
  idempotentPg('POST /merchant/float/topups'),
  async (req, res) => {
    const parsed = amountBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const pool = getPgPool();
    let merchantId: string | undefined;
    try {
      merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
    } catch {
      merchantId = undefined;
    }
    try {
      const result = await requestFloatTopupPg(pool, {
        merchantUserId: req.auth!.userId,
        merchantId,
        amountCents: parseZarToCents(parsed.data.amount),
        requestId: req.requestId,
        correlationId: req.correlationId,
        deviceId: typeof req.headers['x-device-id'] === 'string' ? req.headers['x-device-id'] : undefined,
        ip: req.ip,
      });
      return res.status(201).json({
        ...result,
        notice: 'Float is credited only after a matched bank deposit. Do not treat this request as a credit.',
      });
    } catch (e) {
      const err = e as { status?: number; message?: string; code?: string };
      return res.status(typeof err.status === 'number' ? err.status : 500).json({
        error: err.message ?? 'Float top-up request failed',
        code: err.code,
      });
    }
  },
);

merchantFloatRouterPg.post(
  '/merchant/float/withdrawals',
  idempotentPg('POST /merchant/float/withdrawals'),
  async (req, res) => {
    const parsed = amountBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    try {
      const result = await requestFloatWithdrawalPg(getPgPool(), {
        merchantUserId: req.auth!.userId,
        amountCents: parseZarToCents(parsed.data.amount),
        requestId: req.requestId,
        correlationId: req.correlationId,
        deviceId: typeof req.headers['x-device-id'] === 'string' ? req.headers['x-device-id'] : undefined,
        ip: req.ip,
      });
      return res.status(202).json({
        ...result,
        notice:
          'External bank payout is BLOCKED until a contracted payout adapter exists. This request is a workflow only.',
      });
    } catch (e) {
      const err = e as { status?: number; message?: string; code?: string };
      return res.status(typeof err.status === 'number' ? err.status : 500).json({
        error: err.message ?? 'Float withdrawal request failed',
        code: err.code,
      });
    }
  },
);

const CASH_BANDS = [
  'unavailable',
  'under_500',
  '500_to_1000',
  '1000_to_2000',
  '2000_to_5000',
  'over_5000',
] as const;

merchantFloatRouterPg.get('/merchant/cash-availability', async (req, res) => {
  const pool = getPgPool();
  const merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
  const row = await pool.query<{ availability_band: string; updated_at: string }>(
    `SELECT availability_band, updated_at FROM merchant_cash_availability WHERE merchant_id = $1`,
    [merchantId],
  );
  return res.json({
    availabilityBand: row.rows[0]?.availability_band ?? 'unavailable',
    updatedAt: row.rows[0]?.updated_at ?? null,
  });
});

merchantFloatRouterPg.post('/merchant/cash-availability', async (req, res) => {
  const parsed = z
    .object({ availabilityBand: z.enum(CASH_BANDS) })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const pool = getPgPool();
  const merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
  await pool.query(
    `INSERT INTO merchant_cash_availability (merchant_id, availability_band, updated_at)
     VALUES ($1,$2,clock_timestamp())
     ON CONFLICT (merchant_id)
     DO UPDATE SET availability_band = EXCLUDED.availability_band, updated_at = clock_timestamp()`,
    [merchantId, parsed.data.availabilityBand],
  );
  return res.json({ availabilityBand: parsed.data.availabilityBand });
});

merchantFloatRouterPg.get('/merchant/payout-agent', async (req, res) => {
  const pool = getPgPool();
  const agent = await pool.query(
    `SELECT status, float_floor_cents, per_transaction_limit_cents,
            daily_payout_limit_cents, daily_payout_used_cents, float_suspended
       FROM payout_agents WHERE merchant_id = $1`,
    [req.auth!.userId],
  );
  const float = await getMerchantFloatWalletPg(pool, req.auth!.userId);
  return res.json({
    agent: agent.rows[0] ?? null,
    hasFloatWallet: Boolean(float),
  });
});

merchantFloatRouterPg.post(
  '/merchant/payout-agent/apply',
  idempotentPg('POST /merchant/payout-agent/apply'),
  async (req, res) => {
    try {
      const { applyPayoutAgentPg } = await import('../services/payoutAgentsPg.js');
      const result = await applyPayoutAgentPg(getPgPool(), req.auth!.userId);
      return res.status(201).json(result);
    } catch (e) {
      const err = e as { status?: number; message?: string };
      return res.status(typeof err.status === 'number' ? err.status : 500).json({
        error: err.message ?? 'Payout agent application failed',
      });
    }
  },
);
