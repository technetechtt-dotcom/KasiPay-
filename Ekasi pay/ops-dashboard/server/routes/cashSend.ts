import { Router } from 'express';
import { z } from 'zod';

import { getPgPool, getSqliteDb, isPostgresMode } from '../db.js';
import { toOpsCashSendVoucher, type RowCashSendVoucher } from '../mappers.js';

export const cashSendOpsRouter = Router();

const VOUCHER_SELECT = `
  id, reference_number, status, amount, fee,
  created_at, expires_at, collected_at, cancel_reason,
  sender_user_id, sender_address,
  recipient_first_name, recipient_last_name, recipient_name,
  recipient_phone, recipient_id_document,
  collector_scanned_id, collected_with_id_verified,
  sender_first_name, sender_last_name, sender_name, sender_phone, sender_id_document
`;

const listQuery = z.object({
  status: z.enum(['all', 'active', 'collected', 'expired', 'cancelled']).optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

cashSendOpsRouter.get('/cash-send/vouchers', async (req, res) => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const status = parsed.data.status ?? 'all';
  const search = (parsed.data.search ?? '').trim();
  const limit = parsed.data.limit ?? 100;
  const offset = parsed.data.offset ?? 0;

  if (isPostgresMode()) {
    const pool = getPgPool();
    const params: unknown[] = [];
    const clauses: string[] = [];

    if (status !== 'all') {
      params.push(status);
      clauses.push(`status = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      const i = params.length;
      clauses.push(
        `(reference_number ILIKE $${i}
          OR sender_phone ILIKE $${i} OR sender_first_name ILIKE $${i} OR sender_last_name ILIKE $${i}
          OR sender_address ILIKE $${i} OR cancel_reason ILIKE $${i}
          OR recipient_phone ILIKE $${i} OR recipient_first_name ILIKE $${i} OR recipient_last_name ILIKE $${i}
          OR sender_id_document ILIKE $${i} OR collector_scanned_id ILIKE $${i}
          OR recipient_id_document ILIKE $${i})`,
      );
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(limit, offset);

    const countQ = await pool.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM cash_send_vouchers ${where}`,
      params.slice(0, params.length - 2),
    );
    const sumQ = await pool.query<{ amount_sum: string; fee_sum: string }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS amount_sum,
              COALESCE(SUM(fee), 0)::text AS fee_sum
         FROM cash_send_vouchers ${where}`,
      params.slice(0, params.length - 2),
    );
    const rowsQ = await pool.query<RowCashSendVoucher>(
      `SELECT ${VOUCHER_SELECT}
         FROM cash_send_vouchers
         ${where}
        ORDER BY COALESCE(collected_at, created_at) DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return res.json({
      total: Number(countQ.rows[0]?.total ?? 0),
      amountSum: Number(sumQ.rows[0]?.amount_sum ?? 0),
      feeSum: Number(sumQ.rows[0]?.fee_sum ?? 0),
      limit,
      offset,
      vouchers: rowsQ.rows.map(toOpsCashSendVoucher),
    });
  }

  const db = getSqliteDb();
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (status !== 'all') {
    clauses.push('status = ?');
    params.push(status);
  }
  if (search) {
    clauses.push(
      `(reference_number LIKE ?
        OR sender_phone LIKE ? OR sender_first_name LIKE ? OR sender_last_name LIKE ?
        OR COALESCE(sender_address, '') LIKE ? OR COALESCE(cancel_reason, '') LIKE ?
        OR recipient_phone LIKE ? OR recipient_first_name LIKE ? OR recipient_last_name LIKE ?
        OR sender_id_document LIKE ? OR collector_scanned_id LIKE ?
        OR COALESCE(recipient_id_document, '') LIKE ?)`,
    );
    const like = `%${search}%`;
    params.push(like, like, like, like, like, like, like, like, like, like, like, like);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const countRow = db
    .prepare(`SELECT COUNT(*) AS total FROM cash_send_vouchers ${where}`)
    .get(...params) as { total: number };
  const sumRow = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS amount_sum, COALESCE(SUM(fee), 0) AS fee_sum
         FROM cash_send_vouchers ${where}`,
    )
    .get(...params) as { amount_sum: number; fee_sum: number };

  const rows = db
    .prepare(
      `SELECT ${VOUCHER_SELECT}
         FROM cash_send_vouchers
         ${where}
        ORDER BY datetime(COALESCE(collected_at, created_at)) DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as RowCashSendVoucher[];

  return res.json({
    total: countRow.total,
    amountSum: Number(sumRow.amount_sum ?? 0),
    feeSum: Number(sumRow.fee_sum ?? 0),
    limit,
    offset,
    vouchers: rows.map(toOpsCashSendVoucher),
  });
});
