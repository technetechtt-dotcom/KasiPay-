import { Router } from 'express';
import { z } from 'zod';

import { getPgPool } from '../dbPg.js';
import { formatCents, parseZarToCents } from '../money.js';
import { idempotentPg } from '../middleware/idempotencyPg.js';
import { requireApprovedMerchant } from '../middleware/requireApprovedMerchant.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireMerchantIdPg } from '../services/merchantPg.js';
import {
  CASH_AVAILABILITY_BANDS,
  adjustCashLiquidityPg,
  bandToAvailableCents,
  cashLiquidityIsStale,
  declareCashLiquidityPg,
  getCashLiquidityPg,
  listCashAdjustmentsPg,
  parseAvailableCentsInput,
} from '../services/cashAvailabilityPg.js';
import {
  getFloatAlertsPg,
  getFloatHistoryPg,
  requestFloatTopupPg,
  requestFloatWithdrawalPg,
} from '../services/merchantFloatPg.js';
import { searchPayoutShopsPg } from '../services/payoutShopSearchPg.js';
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
  const alerts = await getFloatAlertsPg(getPgPool(), req.auth!.userId);
  return res.json({ ...history, ...alerts });
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

merchantFloatRouterPg.get('/merchant/cash-availability', async (req, res) => {
  const pool = getPgPool();
  const merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
  const row = await pool.query<{ availability_band: string; updated_at: string }>(
    `SELECT availability_band, updated_at FROM merchant_cash_availability WHERE merchant_id = $1`,
    [merchantId],
  );
  const liquidity = await getCashLiquidityPg(pool, merchantId);
  const verified = await pool.query<{ last_verified_at: string }>(
    `SELECT last_verified_at FROM merchant_cash_liquidity WHERE merchant_id = $1`,
    [merchantId],
  );
  const updatedAt = verified.rows[0]?.last_verified_at ?? row.rows[0]?.updated_at ?? null;
  return res.json({
    availabilityBand: row.rows[0]?.availability_band ?? 'unavailable',
    availableCents: liquidity.availableCents.toString(),
    reservedCents: liquidity.reservedCents.toString(),
    freeCents: liquidity.freeCents.toString(),
    updatedAt,
    stale: cashLiquidityIsStale(updatedAt),
  });
});

merchantFloatRouterPg.post('/merchant/cash-availability', async (req, res) => {
  const parsed = z
    .object({
      availabilityBand: z.enum(CASH_AVAILABILITY_BANDS).optional(),
      availableCents: z.union([z.string(), z.number()]).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (parsed.data.availableCents === undefined && !parsed.data.availabilityBand) {
    return res.status(400).json({
      error: 'Provide availableCents or an availabilityBand to seed cash-on-hand',
    });
  }
  const pool = getPgPool();
  const merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
  try {
    const available =
      parsed.data.availableCents !== undefined
        ? parseAvailableCentsInput(parsed.data.availableCents)
        : bandToAvailableCents(parsed.data.availabilityBand!);
    const liquidity = await declareCashLiquidityPg(
      pool,
      merchantId,
      available,
      parsed.data.availabilityBand,
    );
    return res.json({
      availabilityBand: parsed.data.availabilityBand ?? null,
      availableCents: liquidity.availableCents.toString(),
      reservedCents: liquidity.reservedCents.toString(),
      freeCents: liquidity.freeCents.toString(),
    });
  } catch (e) {
    const err = e as { status?: number; message?: string; code?: string };
    return res.status(typeof err.status === 'number' ? err.status : 400).json({
      error: err.message ?? 'Cash availability update failed',
      code: err.code,
    });
  }
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

merchantFloatRouterPg.post('/merchant/cash-availability/adjust', async (req, res) => {
  const parsed = z
    .object({
      availableCents: z.union([z.string(), z.number()]),
      reason: z.string().min(3).max(500),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const pool = getPgPool();
  const merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
  try {
    const liquidity = await adjustCashLiquidityPg(pool, {
      merchantId,
      nextAvailableCents: parseAvailableCentsInput(parsed.data.availableCents),
      reason: parsed.data.reason,
      actorUserId: req.auth!.userId,
    });
    return res.json({
      availableCents: liquidity.availableCents.toString(),
      reservedCents: liquidity.reservedCents.toString(),
      freeCents: liquidity.freeCents.toString(),
    });
  } catch (e) {
    const err = e as { status?: number; message?: string; code?: string };
    return res.status(typeof err.status === 'number' ? err.status : 400).json({
      error: err.message ?? 'Cash adjustment failed',
      code: err.code,
    });
  }
});

merchantFloatRouterPg.get('/merchant/cash-availability/history', async (req, res) => {
  const pool = getPgPool();
  const merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
  return res.json({ adjustments: await listCashAdjustmentsPg(pool, merchantId) });
});

merchantFloatRouterPg.get('/merchant/payout-shops', async (req, res) => {
  const amountRaw = typeof req.query.amount === 'string' ? req.query.amount : '';
  if (!amountRaw) return res.status(400).json({ error: 'amount is required' });
  try {
    const result = await searchPayoutShopsPg(getPgPool(), {
      amountCents: parseZarToCents(amountRaw),
      latitude: req.query.lat ? Number(req.query.lat) : undefined,
      longitude: req.query.lng ? Number(req.query.lng) : undefined,
      includeStale: req.query.includeStale === '1',
    });
    return res.json(result);
  } catch (e) {
    const err = e as { status?: number; message?: string };
    return res.status(typeof err.status === 'number' ? err.status : 400).json({
      error: err.message ?? 'Payout shop search failed',
    });
  }
});
