import type { NextFunction, Request, Response } from 'express';

import { getDb } from '../db.js';
import { getPgPool } from '../dbPg.js';
import { isPostgresMode } from '../dbRuntime.js';

/**
 * Blocks merchants who have not completed document submission + admin approval
 * from using money / shop APIs. Non-merchant roles pass through.
 */
export async function requireApprovedMerchant(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (!req.auth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (req.auth.role !== 'merchant') {
    return next();
  }

  try {
    let approvalStatus: string | undefined;
    if (isPostgresMode()) {
      const r = await getPgPool().query<{ approval_status: string }>(
        `SELECT approval_status FROM merchants WHERE user_id = $1`,
        [req.auth.userId],
      );
      approvalStatus = r.rows[0]?.approval_status;
    } else {
      const row = getDb()
        .prepare(`SELECT approval_status FROM merchants WHERE user_id = ?`)
        .get(req.auth.userId) as { approval_status: string } | undefined;
      approvalStatus = row?.approval_status;
    }

    // No merchant row yet — treat as not approved for merchant-role users.
    if (!approvalStatus || approvalStatus !== 'approved') {
      return res.status(403).json({
        error:
          'Merchant account is not approved yet. Submit compliance documents and wait for admin review.',
        code: 'MERCHANT_NOT_APPROVED',
        approvalStatus: approvalStatus ?? 'pending_docs',
      });
    }
    return next();
  } catch (e) {
    return next(e);
  }
}
