import { Router } from 'express';
import { z } from 'zod';

import { getPgPool } from '../dbPg.js';
import { toComplianceFlag } from '../extraMappers.js';
import { toPublicUser } from '../mappers.js';
import { requireAuth, requireRoles } from '../middleware/requireAuth.js';
import type { RowUser } from '../types.js';

/**
 * Ops-style monitoring reads on the main API (admin JWT).
 * Replaces the separate ekasi-ops-dashboard Express server.
 */
export const adminMonitoringRouterPg = Router();

const adminOnly = [requireAuth, requireRoles('admin')] as const;

function extractCashSendVoucherNumber(
  description: string | null | undefined,
  reference?: string | null,
): string | null {
  const fromDesc = (description ?? '').toUpperCase().match(/CS[0-9A-F]{8,}/);
  if (fromDesc) return fromDesc[0];
  const fromRef = (reference ?? '').toUpperCase().match(/CS[0-9A-F]{8,}/);
  return fromRef ? fromRef[0] : null;
}

function withVoucherNumber<
  T extends { description?: string | null; reference?: string | null },
>(row: T): T & { voucherNumber: string | null } {
  return {
    ...row,
    voucherNumber: extractCashSendVoucherNumber(row.description, row.reference),
  };
}

type RowCashSendVoucher = {
  id: string;
  reference_number: string;
  status: string;
  amount: number;
  fee: number;
  created_at: string;
  expires_at: string;
  collected_at: string | null;
  cancel_reason?: string | null;
  sender_user_id?: string | null;
  sender_address?: string | null;
  recipient_first_name?: string | null;
  recipient_last_name?: string | null;
  recipient_name?: string | null;
  recipient_phone: string;
  recipient_id_document?: string | null;
  collector_scanned_id?: string | null;
  collected_with_id_verified?: number | boolean | null;
  sender_first_name?: string | null;
  sender_last_name?: string | null;
  sender_name?: string | null;
  sender_phone: string;
  sender_id_document?: string | null;
};

function splitLegacyName(name: string | null | undefined): {
  firstName: string;
  lastName: string;
} {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

function digitsOnly(id: string | null | undefined): string | null {
  const digits = (id ?? '').replace(/\D/g, '');
  return digits.length > 0 ? digits : null;
}

function toOpsCashSendVoucher(row: RowCashSendVoucher) {
  const recipientLegacy = splitLegacyName(row.recipient_name);
  const withdrawerFirstName =
    (row.recipient_first_name ?? '').trim() || recipientLegacy.firstName;
  const withdrawerLastName =
    (row.recipient_last_name ?? '').trim() || recipientLegacy.lastName;
  const senderLegacy = splitLegacyName(row.sender_name);
  const senderFirstName =
    (row.sender_first_name ?? '').trim() || senderLegacy.firstName;
  const senderLastName =
    (row.sender_last_name ?? '').trim() || senderLegacy.lastName;
  const scanned = digitsOnly(row.collector_scanned_id);
  const onFile = digitsOnly(row.recipient_id_document);
  const senderId = digitsOnly(row.sender_id_document);
  const verified =
    row.collected_with_id_verified === 1 ||
    row.collected_with_id_verified === true;

  return {
    id: row.id,
    referenceNumber: row.reference_number,
    status: row.status,
    amount: Number(row.amount),
    fee: Number(row.fee),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    collectedAt: row.collected_at,
    withdrawnAt: row.collected_at,
    cancelReason: row.cancel_reason ?? null,
    senderUserId: row.sender_user_id ?? null,
    senderAddress: (row.sender_address ?? '').trim() || null,
    sender: {
      firstName: senderFirstName,
      lastName: senderLastName,
      phone: row.sender_phone,
      idDocument: senderId,
    },
    withdrawer: {
      firstName: withdrawerFirstName,
      lastName: withdrawerLastName,
      phone: row.recipient_phone,
      idDocument: scanned ?? onFile,
    },
    recipientIdOnFile: onFile,
    collectorScannedId: scanned,
    idVerifiedAtWithdrawal: verified,
  };
}

const VOUCHER_SELECT = `
  id, reference_number, status, amount, fee,
  created_at, expires_at, collected_at, cancel_reason,
  sender_user_id, sender_address,
  recipient_first_name, recipient_last_name, recipient_name,
  recipient_phone, recipient_id_document,
  collector_scanned_id, collected_with_id_verified,
  sender_first_name, sender_last_name, sender_name, sender_phone, sender_id_document
`;

adminMonitoringRouterPg.get('/admin/overview', ...adminOnly, async (_req, res) => {
  const pool = getPgPool();
  const [usersQ, walletsQ, flagsQ, txnsQ, merchantsQ] = await Promise.all([
    pool.query<{ total: string; active: string; suspended: string; merchants: string }>(
      `SELECT
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE deleted_at IS NULL AND suspended_at IS NULL)::text AS active,
         COUNT(*) FILTER (WHERE suspended_at IS NOT NULL AND deleted_at IS NULL)::text AS suspended,
         COUNT(*) FILTER (WHERE role = 'merchant' AND deleted_at IS NULL)::text AS merchants
       FROM users WHERE COALESCE(is_system, 0) = 0`,
    ),
    pool.query<{ total_balance: string; active_wallets: string }>(
      `SELECT
         COALESCE(SUM(balance), 0)::text AS total_balance,
         COUNT(*) FILTER (WHERE status = 'active' AND wallet_kind = 'user')::text AS active_wallets
       FROM wallets WHERE wallet_kind = 'user'`,
    ),
    pool.query<{ open_flags: string }>(
      `SELECT COUNT(*)::text AS open_flags FROM compliance_flags WHERE status = 'open'`,
    ),
    pool.query<{ count: string; volume: string }>(
      `SELECT COUNT(*)::text AS count, COALESCE(SUM(amount), 0)::text AS volume
       FROM transactions
       WHERE created_at >= NOW() - INTERVAL '24 hours'`,
    ),
    pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM merchants`),
  ]);
  const u = usersQ.rows[0];
  const w = walletsQ.rows[0];
  return res.json({
    generatedAt: new Date().toISOString(),
    dataSource: 'postgres',
    users: {
      total: Number(u?.total ?? 0),
      active: Number(u?.active ?? 0),
      suspended: Number(u?.suspended ?? 0),
      merchants: Number(u?.merchants ?? 0),
    },
    wallets: {
      activeCount: Number(w?.active_wallets ?? 0),
      totalUserBalance: Number(Number(w?.total_balance ?? 0).toFixed(2)),
    },
    compliance: { openFlags: Number(flagsQ.rows[0]?.open_flags ?? 0) },
    transactions24h: {
      count: Number(txnsQ.rows[0]?.count ?? 0),
      volume: Number(Number(txnsQ.rows[0]?.volume ?? 0).toFixed(2)),
    },
    merchants: Number(merchantsQ.rows[0]?.count ?? 0),
  });
});

const usersQuery = z.object({
  search: z.string().optional(),
  role: z.enum(['customer', 'merchant', 'admin', 'agent']).optional(),
  status: z.enum(['active', 'suspended', 'deleted']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

adminMonitoringRouterPg.get(
  '/admin/directory/users',
  ...adminOnly,
  async (req, res) => {
    const parsed = usersQuery.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const { search, role, status, limit, offset } = parsed.data;
    const searchTerm = search?.trim().toLowerCase() ?? '';
    const pool = getPgPool();
    const conditions = [`COALESCE(is_system, 0) = 0`];
    const params: unknown[] = [];
    let i = 1;

    if (role) {
      conditions.push(`role = $${i++}`);
      params.push(role);
    }
    if (status === 'active') {
      conditions.push(`deleted_at IS NULL AND suspended_at IS NULL`);
    } else if (status === 'suspended') {
      conditions.push(`suspended_at IS NOT NULL AND deleted_at IS NULL`);
    } else if (status === 'deleted') {
      conditions.push(`deleted_at IS NOT NULL`);
    }
    if (searchTerm) {
      conditions.push(
        `(lower(name) LIKE $${i} OR lower(phone) LIKE $${i} OR lower(id) LIKE $${i})`,
      );
      params.push(`%${searchTerm}%`);
      i++;
    }

    const where = conditions.join(' AND ');
    const countQ = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM users WHERE ${where}`,
      params,
    );
    params.push(limit, offset);
    const rowsQ = await pool.query<RowUser>(
      `SELECT id, name, phone, role, kyc_status, account_tier, created_at,
              country_code, suspended_at, deleted_at
         FROM users
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT $${i++} OFFSET $${i}`,
      params,
    );
    return res.json({
      total: Number(countQ.rows[0]?.c ?? 0),
      limit,
      offset,
      users: rowsQ.rows.map(toPublicUser),
    });
  },
);

adminMonitoringRouterPg.get(
  '/admin/directory/users/:id',
  ...adminOnly,
  async (req, res) => {
    const pool = getPgPool();
    const userId = req.params.id;
    const userQ = await pool.query<RowUser>(
      `SELECT id, name, phone, role, kyc_status, account_tier, created_at,
              country_code, suspended_at, deleted_at
         FROM users WHERE id = $1 AND COALESCE(is_system, 0) = 0`,
      [userId],
    );
    const user = userQ.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    const [walletQ, merchantQ, flagsQ, txnsQ] = await Promise.all([
      pool.query(
        `SELECT id, user_id, balance, currency, status, pool_id, wallet_kind
           FROM wallets WHERE user_id = $1`,
        [userId],
      ),
      pool.query(
        `SELECT id, business_name, location, category, approval_status
           FROM merchants WHERE user_id = $1`,
        [userId],
      ),
      pool.query(
        `SELECT * FROM compliance_flags WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [userId],
      ),
      pool.query(
        `SELECT t.id, t.type, t.amount, t.status, t.reference, t.description, t.created_at
           FROM transactions t
           INNER JOIN wallets w ON w.id = t.from_wallet_id OR w.id = t.to_wallet_id
          WHERE w.user_id = $1
          ORDER BY t.created_at DESC
          LIMIT 25`,
        [userId],
      ),
    ]);

    return res.json({
      user: toPublicUser(user),
      wallet: walletQ.rows[0] ?? null,
      merchant: merchantQ.rows[0] ?? null,
      complianceFlags: flagsQ.rows.map(toComplianceFlag),
      recentTransactions: txnsQ.rows,
    });
  },
);

adminMonitoringRouterPg.get(
  '/admin/transactions',
  ...adminOnly,
  async (req, res) => {
    const parsed = z
      .object({
        search: z.string().optional(),
        type: z.string().optional(),
        status: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const search = (parsed.data.search ?? '').trim();
    const type = (parsed.data.type ?? '').trim();
    const status = (parsed.data.status ?? '').trim();
    const limit = parsed.data.limit ?? 100;
    const offset = parsed.data.offset ?? 0;
    const pool = getPgPool();
    const params: unknown[] = [];
    const clauses: string[] = [];

    if (type && type !== 'all') {
      params.push(type);
      clauses.push(`type = $${params.length}`);
    }
    if (status && status !== 'all') {
      params.push(status);
      clauses.push(`status = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      const i = params.length;
      clauses.push(
        `(reference ILIKE $${i} OR description ILIKE $${i} OR type ILIKE $${i} OR id::text ILIKE $${i})`,
      );
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(limit, offset);

    const [listQ, countQ, filteredQ, periodQ, typesQ] = await Promise.all([
      pool.query(
        `SELECT id, type, amount, status, reference, description, created_at,
                from_wallet_id, to_wallet_id
           FROM transactions
           ${where}
          ORDER BY created_at DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      ),
      pool.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM transactions ${where}`,
        params.slice(0, params.length - 2),
      ),
      pool.query<{ count: string; volume: string }>(
        `SELECT COUNT(*)::text AS count, COALESCE(SUM(amount), 0)::text AS volume
           FROM transactions ${where}`,
        params.slice(0, params.length - 2),
      ),
      pool.query<{
        day_count: string;
        day_volume: string;
        week_count: string;
        week_volume: string;
        month_count: string;
        month_volume: string;
        year_count: string;
        year_volume: string;
      }>(`
        SELECT
          COUNT(*) FILTER (WHERE created_at >= date_trunc('day', NOW()))::text AS day_count,
          COALESCE(SUM(amount) FILTER (WHERE created_at >= date_trunc('day', NOW())), 0)::text AS day_volume,
          COUNT(*) FILTER (WHERE created_at >= date_trunc('week', NOW()))::text AS week_count,
          COALESCE(SUM(amount) FILTER (WHERE created_at >= date_trunc('week', NOW())), 0)::text AS week_volume,
          COUNT(*) FILTER (WHERE created_at >= date_trunc('month', NOW()))::text AS month_count,
          COALESCE(SUM(amount) FILTER (WHERE created_at >= date_trunc('month', NOW())), 0)::text AS month_volume,
          COUNT(*) FILTER (WHERE created_at >= date_trunc('year', NOW()))::text AS year_count,
          COALESCE(SUM(amount) FILTER (WHERE created_at >= date_trunc('year', NOW())), 0)::text AS year_volume
        FROM transactions
      `),
      pool.query<{ type: string }>(
        `SELECT DISTINCT type FROM transactions ORDER BY type ASC`,
      ),
    ]);

    const p = periodQ.rows[0];
    return res.json({
      transactions: listQ.rows.map(withVoucherNumber),
      total: Number(countQ.rows[0]?.total ?? 0),
      limit,
      offset,
      types: typesQ.rows.map((r) => r.type),
      totals: {
        day: {
          count: Number(p?.day_count ?? 0),
          volume: Number(p?.day_volume ?? 0),
        },
        week: {
          count: Number(p?.week_count ?? 0),
          volume: Number(p?.week_volume ?? 0),
        },
        month: {
          count: Number(p?.month_count ?? 0),
          volume: Number(p?.month_volume ?? 0),
        },
        year: {
          count: Number(p?.year_count ?? 0),
          volume: Number(p?.year_volume ?? 0),
        },
        filtered: {
          count: Number(filteredQ.rows[0]?.count ?? 0),
          volume: Number(filteredQ.rows[0]?.volume ?? 0),
        },
      },
    });
  },
);

adminMonitoringRouterPg.get(
  '/admin/reconciliation',
  ...adminOnly,
  async (_req, res) => {
    const pool = getPgPool();
    const tolerance = 0.01;
    const r = await pool.query<{
      wallet_id: string;
      user_id: string;
      pool_id: string;
      wallet_kind: string;
      balance: number;
      ledger_balance: number;
    }>(`
      WITH ledger AS (
        SELECT account_id AS wallet_id,
               SUM(CASE WHEN entry_type = 'credit' THEN amount ELSE 0 END) -
               SUM(CASE WHEN entry_type = 'debit'  THEN amount ELSE 0 END) AS ledger_balance
        FROM ledger_entries
        GROUP BY account_id
      )
      SELECT w.id AS wallet_id, w.user_id, w.pool_id, w.wallet_kind,
             w.balance,
             COALESCE(l.ledger_balance, 0) AS ledger_balance
        FROM wallets w
        LEFT JOIN ledger l ON l.wallet_id = w.id
    `);
    const discrepancies = r.rows
      .filter((row) => Math.abs(row.balance - row.ledger_balance) > tolerance)
      .map((row) => ({
        walletId: row.wallet_id,
        userId: row.user_id,
        poolId: row.pool_id,
        kind: row.wallet_kind,
        walletBalance: Number(row.balance.toFixed(2)),
        ledgerBalance: Number(row.ledger_balance.toFixed(2)),
        delta: Number((row.balance - row.ledger_balance).toFixed(2)),
      }));
    return res.json({
      ranAt: new Date().toISOString(),
      walletsChecked: r.rows.length,
      discrepancies,
      ok: discrepancies.length === 0,
    });
  },
);

const cashSendListQuery = z.object({
  status: z.enum(['all', 'active', 'collected', 'expired', 'cancelled']).optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

adminMonitoringRouterPg.get(
  '/admin/cash-send/vouchers',
  ...adminOnly,
  async (req, res) => {
    const parsed = cashSendListQuery.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const status = parsed.data.status ?? 'all';
    const search = (parsed.data.search ?? '').trim();
    const limit = parsed.data.limit ?? 100;
    const offset = parsed.data.offset ?? 0;
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
  },
);
