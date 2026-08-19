import { Router } from 'express';

import { getPgPool } from '../dbPg.js';
import { formatCents, parseIntegerCents } from '../money.js';
import { requireAuth } from '../middleware/requireAuth.js';

export const commissionsRouterPg = Router();

export type CommissionPostingDto = {
  id: string;
  agentUserId: string;
  sourceType: string;
  sourceId: string;
  amount: string;
  description: string;
  createdAt: string;
};

type CommissionRow = {
  id: string;
  agent_user_id: string;
  source_type: string;
  source_id: string;
  amount_cents: string;
  description: string;
  created_at: string;
};

const toDto = (r: CommissionRow): CommissionPostingDto => ({
  id: r.id,
  agentUserId: r.agent_user_id,
  sourceType: r.source_type,
  sourceId: r.source_id,
  amount: formatCents(parseIntegerCents(r.amount_cents)),
  description: r.description,
  createdAt: r.created_at,
});

commissionsRouterPg.get('/commissions/me', requireAuth, async (req, res) => {
  const pool = getPgPool();
  const r = await pool.query<CommissionRow>(
    `SELECT * FROM commission_postings
      WHERE agent_user_id = $1
      ORDER BY created_at DESC
      LIMIT 200`,
    [req.auth!.userId],
  );
  const rows = r.rows;
  const total = rows.reduce(
    (sum, row) => sum + parseIntegerCents(row.amount_cents),
    0n,
  );
  const now = new Date();
  const thisMonth = rows
    .filter((row) => {
      const d = new Date(row.created_at);
      return (
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth()
      );
    })
    .reduce(
      (sum, row) => sum + parseIntegerCents(row.amount_cents),
      0n,
    );
  return res.json({
    postings: rows.map(toDto),
    totals: {
      lifetime: formatCents(total),
      thisMonth: formatCents(thisMonth),
    },
  });
});

commissionsRouterPg.get('/commissions/me/statement', requireAuth, async (req, res) => {
  const from = typeof req.query.from === 'string' ? req.query.from : '1970-01-01';
  const to = typeof req.query.to === 'string' ? req.query.to : '2999-12-31';
  const pool = getPgPool();
  const r = await pool.query<{
    day: string;
    source_type: string;
    posting_count: string;
    net_cents: string;
  }>(
    `SELECT created_at::date::text AS day, source_type,
            count(*)::text AS posting_count,
            coalesce(sum(amount_cents),0)::text AS net_cents
       FROM commission_postings
      WHERE agent_user_id = $1
        AND created_at::date >= $2::date
        AND created_at::date <= $3::date
      GROUP BY 1, 2
      ORDER BY 1 DESC, 2`,
    [req.auth!.userId, from, to],
  );
  const lines = r.rows.map((row) => ({
    day: row.day,
    sourceType: row.source_type,
    postingCount: Number(row.posting_count),
    net: formatCents(parseIntegerCents(row.net_cents)),
  }));
  const net = r.rows.reduce((sum, row) => sum + parseIntegerCents(row.net_cents), 0n);
  return res.json({
    from,
    to,
    lines,
    net: formatCents(net),
    pricing: { cashSendFeeCents: 900, merchantShareCents: 300, platformShareCents: 600 },
  });
});
