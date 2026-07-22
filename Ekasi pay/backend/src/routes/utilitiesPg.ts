import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import { getPgPool } from '../dbPg.js';
import { IS_LOCAL_ENV, UTILITY_VENDOR_API_KEY } from '../config.js';
import { toTransaction } from '../mappers.js';
import {
  formatCents,
  parseIntegerCents,
  parseZarToCents,
} from '../money.js';
import { idempotentPg } from '../middleware/idempotencyPg.js';
import { requireApprovedMerchant } from '../middleware/requireApprovedMerchant.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { DEFAULT_POOL_ID } from '../poolConstants.js';
import { getEscrowWalletIdForPoolPg } from '../services/escrowPg.js';
import {
  fulfillUtilityPurchase,
  getUtilityProviderStatus,
} from '../services/utilityProvider.js';
import {
  createProviderInstructionPg,
  dispatchProviderInstructionPg,
  type ProviderAdapter,
} from '../services/providerFrameworkPg.js';
import {
  postBetweenWalletsPg,
  reverseWalletPostingPg,
} from '../services/walletPostingPg.js';

export const utilitiesRouterPg = Router();

utilitiesRouterPg.use(requireAuth, requireApprovedMerchant);

const buyBody = z.object({
  catalogueVersionId: z.string().uuid(),
  beneficiary: z.string().min(3).max(64),
  amount: z.union([z.string(), z.number()]),
});

type UtilityRow = {
  id: string;
  user_id: string;
  category: string;
  provider: string;
  beneficiary: string;
  amount_cents: string;
  reference: string;
  voucher_code: string | null;
  status: string;
  created_at: string;
};

utilitiesRouterPg.get(
  '/utility-purchases/status',
  requireAuth,
  (_req, res) => {
    const status = getUtilityProviderStatus();
    return res.json(status);
  },
);

utilitiesRouterPg.post(
  '/utility-purchases',
  requireAuth,
  idempotentPg('POST /utility-purchases'),
  async (req, res) => {
    const parsed = buyBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    let amountCents;
    try {
      amountCents = parseZarToCents(parsed.data.amount);
    } catch (error) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : 'Invalid amount',
      });
    }

    const providerStatus = getUtilityProviderStatus();
    if (!providerStatus.available) {
      return res.status(503).json({
        error: 'Utility purchases are not available on this deployment.',
      });
    }
    if (amountCents > parseZarToCents(providerStatus.maxAmount)) {
      return res.status(400).json({
        error: `Amount exceeds maximum of R${providerStatus.maxAmount}`,
      });
    }

    const pool = getPgPool();
    const catalogue = await pool.query<{
      id: string;
      category: 'electricity' | 'water' | 'airtime' | 'data';
      provider: string;
      provider_product_ref: string;
      cost_cents: string;
      fee_cents: string;
      min_cents: string;
      max_cents: string;
      finality_sha256: string;
      endpoint_id: string;
    }>(
      `SELECT c.id,c.category,e.provider,c.provider_product_ref,c.cost_cents,
              c.fee_cents,c.min_cents,c.max_cents,c.finality_sha256,c.endpoint_id
         FROM utility_catalogue_versions c
         JOIN provider_endpoints e ON e.id = c.endpoint_id
        WHERE c.id = $1 AND c.state = 'published' AND e.enabled
          AND e.environment = $2`,
      [parsed.data.catalogueVersionId, IS_LOCAL_ENV ? 'sandbox' : 'production'],
    );
    const selected = catalogue.rows[0];
    if (!selected) {
      return res.status(409).json({ error: 'Published provider catalogue item not found.' });
    }
    if (
      amountCents < BigInt(selected.min_cents) ||
      amountCents > BigInt(selected.max_cents)
    ) {
      return res.status(400).json({ error: 'Amount is outside the provider catalogue limits.' });
    }
    const userWalletQ = await pool.query<{
      id: string;
      balance_cents: string;
      status: string;
      pool_id: string | null;
    }>(
      `SELECT id, balance_cents, status, pool_id FROM wallets
        WHERE user_id = $1 AND COALESCE(wallet_kind, 'user') = 'user'`,
      [req.auth!.userId],
    );
    const userWallet = userWalletQ.rows[0];
    if (!userWallet || userWallet.status !== 'active') {
      return res.status(400).json({ error: 'Wallet unavailable' });
    }
    if (
      parseIntegerCents(userWallet.balance_cents, { allowZero: true }) <
      amountCents
    ) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }
    const poolId = userWallet.pool_id ?? DEFAULT_POOL_ID;
    const escrowId = await getEscrowWalletIdForPoolPg(pool, poolId);
    if (!escrowId) {
      return res.status(503).json({ error: 'Regional float is unavailable' });
    }

    const id = randomUUID();
    const reference = `UTL-${id.slice(0, 8).toUpperCase()}`;
    const now = new Date().toISOString();

    const client = await pool.connect();
    let holdTransactionId = '';
    let instructionId = '';
    try {
      await client.query('BEGIN');
      const endpoint = await client.query<{
        id: string;
        timeout_ms: number;
        max_attempts: number;
      }>(
        `SELECT id,timeout_ms,max_attempts FROM provider_endpoints
          WHERE id = $1 AND product = 'utility' AND environment = $2 AND enabled`,
        [selected.endpoint_id, IS_LOCAL_ENV ? 'sandbox' : 'production'],
      );
      if (!endpoint.rows[0]) {
        throw Object.assign(new Error('No certified utility provider endpoint is enabled'), { status: 503 });
      }
      const hold = await postBetweenWalletsPg(client, {
        fromWalletId: userWallet.id,
        toWalletId: escrowId,
        amountCents,
        type: 'utility_authorization',
        referencePrefix: 'UTL',
        reference,
        description: `${selected.category}/${selected.provider_product_ref} authorization → ${parsed.data.beneficiary}`,
      });
      holdTransactionId = hold.transactionId;
      instructionId = await createProviderInstructionPg(client, {
        endpointId: endpoint.rows[0].id,
        instructionType: 'utility_fulfillment',
        idempotencyKey: String(req.headers['idempotency-key']),
        financialReference: reference,
        journalTransactionId: hold.transactionId,
        payload: {
          category: selected.category,
          provider: selected.provider,
          providerProductRef: selected.provider_product_ref,
          beneficiary: parsed.data.beneficiary,
          amountCents: amountCents.toString(),
          reference,
        },
      });
      await client.query(
        `INSERT INTO utility_purchases
          (id, user_id, category, provider, beneficiary, amount_cents, reference,
           voucher_code, status, created_at, provider_instruction_id,
           journal_transaction_id,catalogue_version_id,cost_cents,fee_cents,
           finality_disclosure_sha256)
          VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, 'authorized', $8, $9, $10,
                  $11,$12,$13,$14)`,
        [
          id,
          req.auth!.userId,
          selected.category,
          selected.provider,
          parsed.data.beneficiary,
          amountCents.toString(),
          reference,
          now,
          instructionId,
          hold.transactionId,
          selected.id,
          selected.cost_cents,
          selected.fee_cents,
          selected.finality_sha256,
        ],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      const err = e as { status?: number; message?: string };
      return res.status(typeof err.status === 'number' ? err.status : 500).json({
        error: err.message ?? 'Purchase failed',
      });
    } finally {
      client.release();
    }

    const endpoint = await pool.query<{ timeout_ms: number; max_attempts: number }>(
      `SELECT e.timeout_ms,e.max_attempts FROM provider_endpoints e
        JOIN provider_instructions i ON i.endpoint_id = e.id WHERE i.id = $1`,
      [instructionId],
    );
    const adapter: ProviderAdapter = {
      submit: async () => {
        const fulfilled = await fulfillUtilityPurchase({
          category: selected.category,
          provider: selected.provider,
          beneficiary: parsed.data.beneficiary,
          amount: formatCents(amountCents),
          reference,
          userId: req.auth!.userId,
        });
        return {
          state: 'fulfilled',
          providerReference: fulfilled.providerReference,
          token: fulfilled.voucherCode,
          response: {
            voucherCode: fulfilled.voucherCode,
            providerReference: fulfilled.providerReference,
            mocked: fulfilled.mocked,
          },
        };
      },
      query: async (providerReference) => ({
        state: 'unknown',
        providerReference,
        response: { code: 'REQUERY_NOT_CERTIFIED' },
      }),
    };
    let fulfillment: {
      voucherCode?: string;
      providerReference?: string;
      mocked?: boolean;
    } = {};
    const dispatchClient = await pool.connect();
    try {
      await dispatchClient.query('BEGIN');
      const result = await dispatchProviderInstructionPg(dispatchClient, {
        instructionId,
        signingSecret: UTILITY_VENDOR_API_KEY || 'sandbox-only-signing-key',
        adapter,
        timeoutMs: endpoint.rows[0]?.timeout_ms ?? 5_000,
        maxAttempts: endpoint.rows[0]?.max_attempts ?? 5,
      });
      fulfillment = result.response as typeof fulfillment;
      if (result.state !== 'fulfilled') {
        await reverseWalletPostingPg(dispatchClient, {
          originalTransactionId: holdTransactionId,
          kind: 'full',
          description: `Utility authorization reversed after provider ${result.state}`,
        });
        await dispatchClient.query(
          `UPDATE utility_purchases SET status = 'failed',failure_reason = $2 WHERE id = $1`,
          [id, `provider_${result.state}`],
        );
        await dispatchClient.query('COMMIT');
        return res.status(502).json({ error: 'Provider did not fulfill the purchase' });
      }
      await dispatchClient.query(
        `UPDATE utility_purchases
            SET status = 'completed',voucher_code = $2,provider_reference = $3
          WHERE id = $1`,
        [id, fulfillment.voucherCode, fulfillment.providerReference ?? null],
      );
      await dispatchClient.query('COMMIT');
    } catch {
      await dispatchClient.query('ROLLBACK');
      await pool.query(
        `UPDATE utility_purchases
            SET status = 'unknown',failure_reason = 'provider_outcome_unknown'
          WHERE id = $1;
         UPDATE provider_instructions
            SET state = 'unknown',unknown_since = COALESCE(unknown_since,clock_timestamp()),
                updated_at = clock_timestamp()
          WHERE id = $2 AND state NOT IN ('fulfilled','reversed')`,
        [id, instructionId],
      );
      return res.status(202).json({
        purchase: { id, reference, status: 'unknown' },
        message: 'Provider outcome is unknown; value remains reserved pending re-query.',
      });
    } finally {
      dispatchClient.release();
    }

    const txnQ = await pool.query(
      `SELECT * FROM transactions WHERE reference = $1 ORDER BY created_at DESC LIMIT 1`,
      [reference],
    );
    const txnRow = txnQ.rows[0] as {
      id: string;
      from_wallet_id: string | null;
      to_wallet_id: string | null;
      amount_cents: string;
      type: string;
      status: string;
      reference: string;
      description: string;
      created_at: string;
    } | undefined;

    const status = getUtilityProviderStatus();
    const voucher = fulfillment.voucherCode;
    return res.status(201).json({
      purchase: {
        id,
        category: selected.category,
        provider: selected.provider,
        beneficiary: parsed.data.beneficiary,
        amount: formatCents(amountCents),
        reference,
        voucherCode: voucher,
        status: 'completed' as const,
        createdAt: now,
        mocked: Boolean(fulfillment.mocked),
        providerReference: fulfillment.providerReference,
      },
      transaction: txnRow ? toTransaction(txnRow) : undefined,
      provider: status,
    });
  },
);

utilitiesRouterPg.get('/utility-purchases', requireAuth, async (req, res) => {
  const status = getUtilityProviderStatus();
  const pool = getPgPool();
  const r = await pool.query<UtilityRow>(
    `SELECT * FROM utility_purchases
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [req.auth!.userId],
  );
  return res.json({
    purchases: r.rows.map((row) => ({
      id: row.id,
      category: row.category,
      provider: row.provider,
      beneficiary: row.beneficiary,
      amount: formatCents(parseIntegerCents(row.amount_cents)),
      reference: row.reference,
      voucherCode: row.voucher_code,
      status: row.status,
      createdAt: row.created_at,
      mocked: status.mocked,
    })),
    provider: status,
  });
});
