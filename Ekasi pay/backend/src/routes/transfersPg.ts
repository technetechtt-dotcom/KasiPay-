import { randomUUID } from 'node:crypto';

import { Router } from 'express';

import { getPgPool } from '../dbPg.js';
import { createTransfer } from '../domain/transfers.js';
import { toTransaction } from '../mappers.js';
import { parseZarToCents } from '../money.js';
import { idempotentPg } from '../middleware/idempotencyPg.js';
import { requireApprovedMerchant } from '../middleware/requireApprovedMerchant.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { PgTransferRepository } from '../repositories/transferPgRepository.js';
import { transferBodySchema } from '../validation.js';
import { evaluateTransactionRiskPg } from '../services/riskPg.js';

export const transfersRouterPg = Router();

transfersRouterPg.use(requireAuth, requireApprovedMerchant);

transfersRouterPg.post(
  '/transfers',
  requireAuth,
  idempotentPg('POST /transfers'),
  async (req, res) => {
    const parsed = transferBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const { toPhone, amount, description } = parsed.data;
    try {
      const amountCents = parseZarToCents(amount);
      const riskReference = `RISK-${randomUUID()}`;
      const risk = await evaluateTransactionRiskPg(getPgPool(), {
        eventType: 'transfer',
        actorUserId: req.auth!.userId,
        amountCents,
        financialReference: riskReference,
        deviceId: typeof req.headers['x-device-id'] === 'string' ? req.headers['x-device-id'] : undefined,
        ip: req.ip,
        counterparty: toPhone,
        requestId: req.requestId,
        correlationId: req.correlationId,
      });
      if (risk.decision === 'block') {
        return res.status(403).json({ error: 'Transaction declined by configured risk controls.', code: 'RISK_BLOCKED' });
      }
      if (risk.decision === 'hold') {
        return res.status(202).json({ status: 'held_for_review', referenceNumber: riskReference });
      }
      const transaction = await createTransfer(
        new PgTransferRepository(getPgPool()),
        {
          fromUserId: req.auth!.userId,
          fromPhone: req.auth!.phone,
          toPhone,
          amountCents,
          description,
        },
      );
      return res.status(201).json({ transaction: toTransaction(transaction) });
    } catch (e) {
      const err = e as { status?: number; message?: string };
      return res.status(typeof err.status === 'number' ? err.status : 500).json({
        error: err.message ?? 'Transfer failed',
      });
    }
  },
);
