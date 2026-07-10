import { Router } from 'express';
import { z } from 'zod';

import { getPgPool, getSqliteDb, isPostgresMode } from '../db.js';
import { toComplianceFlag, toPublicUser, type RowUser } from '../mappers.js';

export const monitoringRouter = Router();

monitoringRouter.get('/overview', async (_req, res) => {
  if (isPostgresMode()) {
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
      pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM merchants`,
      ),
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
  }

  const db = getSqliteDb();
  const users = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN deleted_at IS NULL AND suspended_at IS NULL THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN suspended_at IS NOT NULL AND deleted_at IS NULL THEN 1 ELSE 0 END) AS suspended,
         SUM(CASE WHEN role = 'merchant' AND deleted_at IS NULL THEN 1 ELSE 0 END) AS merchants
       FROM users WHERE COALESCE(is_system, 0) = 0`,
    )
    .get() as {
    total: number;
    active: number;
    suspended: number;
    merchants: number;
  };
  const wallets = db
    .prepare(
      `SELECT
         COALESCE(SUM(balance), 0) AS total_balance,
         SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_wallets
       FROM wallets WHERE COALESCE(wallet_kind, 'user') = 'user'`,
    )
    .get() as { total_balance: number; active_wallets: number };
  const openFlags = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM compliance_flags WHERE status = 'open'`)
      .get() as { c: number }
  ).c;
  const txns = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS volume
       FROM transactions
       WHERE datetime(created_at) >= datetime('now', '-24 hours')`,
    )
    .get() as { count: number; volume: number };
  const merchantCount = (
    db.prepare(`SELECT COUNT(*) AS c FROM merchants`).get() as { c: number }
  ).c;

  return res.json({
    generatedAt: new Date().toISOString(),
    dataSource: 'sqlite',
    users: {
      total: users.total,
      active: users.active,
      suspended: users.suspended,
      merchants: users.merchants,
    },
    wallets: {
      activeCount: wallets.active_wallets,
      totalUserBalance: Number(wallets.total_balance.toFixed(2)),
    },
    compliance: { openFlags },
    transactions24h: {
      count: txns.count,
      volume: Number(txns.volume.toFixed(2)),
    },
    merchants: merchantCount,
  });
});

const usersQuery = z.object({
  search: z.string().optional(),
  role: z.enum(['customer', 'merchant', 'admin']).optional(),
  status: z.enum(['active', 'suspended', 'deleted']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

monitoringRouter.get('/users', async (req, res) => {
  const parsed = usersQuery.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { search, role, status, limit, offset } = parsed.data;
  const searchTerm = search?.trim().toLowerCase() ?? '';

  if (isPostgresMode()) {
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
  }

  const db = getSqliteDb();
  const conditions = [`COALESCE(is_system, 0) = 0`];
  const params: unknown[] = [];

  if (role) {
    conditions.push(`role = ?`);
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
    conditions.push(`(lower(name) LIKE ? OR lower(phone) LIKE ? OR lower(id) LIKE ?)`);
    const like = `%${searchTerm}%`;
    params.push(like, like, like);
  }

  const where = conditions.join(' AND ');
  const total = (
    db.prepare(`SELECT COUNT(*) AS c FROM users WHERE ${where}`).get(...params) as {
      c: number;
    }
  ).c;
  const rows = db
    .prepare(
      `SELECT id, name, phone, role, kyc_status, account_tier, created_at,
              country_code, suspended_at, deleted_at
         FROM users
        WHERE ${where}
        ORDER BY datetime(created_at) DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as RowUser[];

  return res.json({
    total,
    limit,
    offset,
    users: rows.map(toPublicUser),
  });
});

monitoringRouter.get('/users/:id', async (req, res) => {
  const userId = req.params.id;

  if (isPostgresMode()) {
    const pool = getPgPool();
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
        `SELECT id, business_name, location, category FROM merchants WHERE user_id = $1`,
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
  }

  const db = getSqliteDb();
  const user = db
    .prepare(
      `SELECT id, name, phone, role, kyc_status, account_tier, created_at,
              country_code, suspended_at, deleted_at
         FROM users WHERE id = ? AND COALESCE(is_system, 0) = 0`,
    )
    .get(userId) as RowUser | undefined;
  if (!user) return res.status(404).json({ error: 'User not found' });

  const wallet = db
    .prepare(
      `SELECT id, user_id, balance, currency, status, pool_id, wallet_kind
         FROM wallets WHERE user_id = ?`,
    )
    .get(userId);
  const merchant = db
    .prepare(
      `SELECT id, business_name, location, category FROM merchants WHERE user_id = ?`,
    )
    .get(userId);
  const flags = db
    .prepare(
      `SELECT * FROM compliance_flags WHERE user_id = ? ORDER BY datetime(created_at) DESC LIMIT 20`,
    )
    .all(userId);
  const txns = db
    .prepare(
      `SELECT t.id, t.type, t.amount, t.status, t.reference, t.description, t.created_at
         FROM transactions t
         INNER JOIN wallets w ON w.id = t.from_wallet_id OR w.id = t.to_wallet_id
        WHERE w.user_id = ?
        ORDER BY datetime(t.created_at) DESC
        LIMIT 25`,
    )
    .all(userId);

  return res.json({
    user: toPublicUser(user),
    wallet: wallet ?? null,
    merchant: merchant ?? null,
    complianceFlags: (flags as Parameters<typeof toComplianceFlag>[0][]).map(
      toComplianceFlag,
    ),
    recentTransactions: txns,
  });
});

monitoringRouter.get('/compliance/flags', async (req, res) => {
  const status =
    typeof req.query.status === 'string' ? req.query.status : undefined;
  const limit = Math.min(Number(req.query.limit ?? 200), 500);

  if (isPostgresMode()) {
    const pool = getPgPool();
    const r = status
      ? await pool.query(
          `SELECT f.*, u.name AS user_name, u.phone AS user_phone
             FROM compliance_flags f
             LEFT JOIN users u ON u.id = f.user_id
            WHERE f.status = $1
            ORDER BY f.created_at DESC
            LIMIT $2`,
          [status, limit],
        )
      : await pool.query(
          `SELECT f.*, u.name AS user_name, u.phone AS user_phone
             FROM compliance_flags f
             LEFT JOIN users u ON u.id = f.user_id
            ORDER BY f.created_at DESC
            LIMIT $1`,
          [limit],
        );
    return res.json({
      flags: r.rows.map((row) => ({
        ...toComplianceFlag(row),
        userName: row.user_name ?? undefined,
        userPhone: row.user_phone ?? undefined,
      })),
    });
  }

  const db = getSqliteDb();
  const sql = status
    ? `SELECT f.*, u.name AS user_name, u.phone AS user_phone
         FROM compliance_flags f
         LEFT JOIN users u ON u.id = f.user_id
        WHERE f.status = ?
        ORDER BY datetime(f.created_at) DESC
        LIMIT ?`
    : `SELECT f.*, u.name AS user_name, u.phone AS user_phone
         FROM compliance_flags f
         LEFT JOIN users u ON u.id = f.user_id
        ORDER BY datetime(f.created_at) DESC
        LIMIT ?`;
  const rows = (
    status ? db.prepare(sql).all(status, limit) : db.prepare(sql).all(limit)
  ) as (Parameters<typeof toComplianceFlag>[0] & {
    user_name?: string;
    user_phone?: string;
  })[];

  return res.json({
    flags: rows.map((row) => ({
      ...toComplianceFlag(row),
      userName: row.user_name,
      userPhone: row.user_phone,
    })),
  });
});

monitoringRouter.get('/audit-events', async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 200), 1000);

  if (isPostgresMode()) {
    const pool = getPgPool();
    const r = await pool.query(
      `SELECT * FROM audit_events ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return res.json({
      events: r.rows.map((row) => ({
        id: row.id,
        type: row.type,
        message: row.message,
        actorUserId: row.actor_user_id ?? undefined,
        createdAt: row.created_at,
      })),
    });
  }

  const db = getSqliteDb();
  const rows = db
    .prepare(`SELECT * FROM audit_events ORDER BY datetime(created_at) DESC LIMIT ?`)
    .all(limit) as {
    id: string;
    type: string;
    message: string;
    actor_user_id: string | null;
    created_at: string;
  }[];

  return res.json({
    events: rows.map((row) => ({
      id: row.id,
      type: row.type,
      message: row.message,
      actorUserId: row.actor_user_id ?? undefined,
      createdAt: row.created_at,
    })),
  });
});

monitoringRouter.get('/transactions', async (req, res) => {
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

  const periodTotalsSqlPg = `
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
  `;

  if (isPostgresMode()) {
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
      }>(periodTotalsSqlPg),
      pool.query<{ type: string }>(
        `SELECT DISTINCT type FROM transactions ORDER BY type ASC`,
      ),
    ]);

    const p = periodQ.rows[0];
    return res.json({
      transactions: listQ.rows,
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
  }

  const db = getSqliteDb();
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (type && type !== 'all') {
    clauses.push('type = ?');
    params.push(type);
  }
  if (status && status !== 'all') {
    clauses.push('status = ?');
    params.push(status);
  }
  if (search) {
    clauses.push(
      `(reference LIKE ? OR description LIKE ? OR type LIKE ? OR id LIKE ?)`,
    );
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT id, type, amount, status, reference, description, created_at,
              from_wallet_id, to_wallet_id
         FROM transactions
         ${where}
        ORDER BY datetime(created_at) DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);
  const countRow = db
    .prepare(`SELECT COUNT(*) AS total FROM transactions ${where}`)
    .get(...params) as { total: number };
  const filteredRow = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS volume
         FROM transactions ${where}`,
    )
    .get(...params) as { count: number; volume: number };

  const periodRow = db
    .prepare(
      `SELECT
         SUM(CASE WHEN datetime(created_at) >= datetime('now', 'start of day') THEN 1 ELSE 0 END) AS day_count,
         SUM(CASE WHEN datetime(created_at) >= datetime('now', 'start of day') THEN amount ELSE 0 END) AS day_volume,
         SUM(CASE WHEN datetime(created_at) >= datetime('now', 'weekday 0', '-6 days') THEN 1 ELSE 0 END) AS week_count,
         SUM(CASE WHEN datetime(created_at) >= datetime('now', 'weekday 0', '-6 days') THEN amount ELSE 0 END) AS week_volume,
         SUM(CASE WHEN datetime(created_at) >= datetime('now', 'start of month') THEN 1 ELSE 0 END) AS month_count,
         SUM(CASE WHEN datetime(created_at) >= datetime('now', 'start of month') THEN amount ELSE 0 END) AS month_volume,
         SUM(CASE WHEN datetime(created_at) >= datetime('now', 'start of year') THEN 1 ELSE 0 END) AS year_count,
         SUM(CASE WHEN datetime(created_at) >= datetime('now', 'start of year') THEN amount ELSE 0 END) AS year_volume
       FROM transactions`,
    )
    .get() as {
    day_count: number;
    day_volume: number;
    week_count: number;
    week_volume: number;
    month_count: number;
    month_volume: number;
    year_count: number;
    year_volume: number;
  };

  const types = (
    db.prepare(`SELECT DISTINCT type FROM transactions ORDER BY type ASC`).all() as {
      type: string;
    }[]
  ).map((r) => r.type);

  return res.json({
    transactions: rows,
    total: countRow.total,
    limit,
    offset,
    types,
    totals: {
      day: {
        count: Number(periodRow.day_count ?? 0),
        volume: Number(periodRow.day_volume ?? 0),
      },
      week: {
        count: Number(periodRow.week_count ?? 0),
        volume: Number(periodRow.week_volume ?? 0),
      },
      month: {
        count: Number(periodRow.month_count ?? 0),
        volume: Number(periodRow.month_volume ?? 0),
      },
      year: {
        count: Number(periodRow.year_count ?? 0),
        volume: Number(periodRow.year_volume ?? 0),
      },
      filtered: {
        count: Number(filteredRow.count ?? 0),
        volume: Number(filteredRow.volume ?? 0),
      },
    },
  });
});

monitoringRouter.get('/reconciliation', async (_req, res) => {
  const tolerance = 0.01;

  if (isPostgresMode()) {
    const pool = getPgPool();
    const r = await pool.query<{
      wallet_id: string;
      user_id: string;
      pool_id: string;
      wallet_kind: string;
      balance: number;
      ledger_balance: number;
    }>(
      `
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
      `,
    );
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
  }

  const db = getSqliteDb();
  const rows = db
    .prepare(
      `
      WITH ledger AS (
        SELECT account_id AS wallet_id,
               SUM(CASE WHEN entry_type = 'credit' THEN amount ELSE 0 END) -
               SUM(CASE WHEN entry_type = 'debit'  THEN amount ELSE 0 END) AS ledger_balance
        FROM ledger_entries
        GROUP BY account_id
      )
      SELECT w.id AS wallet_id, w.user_id, w.pool_id, w.wallet_kind AS wallet_kind,
             w.balance AS balance,
             COALESCE(l.ledger_balance, 0) AS ledger_balance
        FROM wallets w
        LEFT JOIN ledger l ON l.wallet_id = w.id
      `,
    )
    .all() as {
    wallet_id: string;
    user_id: string;
    pool_id: string;
    wallet_kind: string;
    balance: number;
    ledger_balance: number;
  }[];

  const discrepancies = rows
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
    walletsChecked: rows.length,
    discrepancies,
    ok: discrepancies.length === 0,
  });
});
