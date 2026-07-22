import type { NextFunction, Request, Response } from 'express';

import {
  CASH_SEND_ENABLED,
  FINANCIAL_POSTING_ENABLED,
  INSURANCE_ENABLED,
  LENDING_DISBURSEMENT_ENABLED,
  LENDING_ENABLED,
  LIVE_UTILITIES_ENABLED,
  STOKVEL_MONEY_MOVEMENT_ENABLED,
} from '../config.js';
import { getPgPool } from '../dbPg.js';
import { isPostgresMode } from '../dbRuntime.js';
import { evaluateMutationPolicy, isFinancialPostingMutation } from '../productionPolicy.js';

const flags = {
  financialPosting: FINANCIAL_POSTING_ENABLED,
  lending: LENDING_ENABLED,
  lendingDisbursement: LENDING_DISBURSEMENT_ENABLED,
  insurance: INSURANCE_ENABLED,
  stokvelMoneyMovement: STOKVEL_MONEY_MOVEMENT_ENABLED,
  cashSend: CASH_SEND_ENABLED,
  liveUtilities: LIVE_UTILITIES_ENABLED,
};

export async function enforceProductionControls(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const decision = evaluateMutationPolicy(
    req.method,
    req.path,
    flags,
    req.body,
  );
  if (!decision.allowed) {
    return res.status(503).json({
      error: decision.message,
      code: decision.code,
    });
  }
  if (isPostgresMode() && isFinancialPostingMutation(req.method, req.path)) {
    const control = await getPgPool().query<{ enabled: boolean }>(
      `SELECT enabled FROM operational_controls WHERE control_key = 'financial_posting'`,
    );
    if (control.rows[0]?.enabled === false) {
      return res.status(503).json({
        error: 'New financial postings are paused by operations. Reads, authentication, and investigations remain available.',
        code: 'OPERATIONAL_POSTING_KILL_SWITCH',
      });
    }
  }
  return next();
}

/** Authenticated clients can discover which money products are currently enabled. */
export function getRuntimeProductControls() {
  return {
    financialPosting: flags.financialPosting,
    lending: flags.lending && flags.lendingDisbursement,
    insurance: flags.insurance,
    stokvelMoneyMovement: flags.stokvelMoneyMovement,
    cashSend: flags.cashSend,
    liveUtilities: flags.liveUtilities,
  };
}
