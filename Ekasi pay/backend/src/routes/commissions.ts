import { Router } from 'express';

import { getDb } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

export const commissionsRouter = Router();

export type CommissionPostingDto = {
  id: string;
  agentUserId: string;
  sourceType: string;
  sourceId: string;
  amount: number;
  description: string;
  createdAt: string;
};

type CommissionRow = {
  id: string;
  agent_user_id: string;
  source_type: string;
  source_id: string;
  amount: number;
  description: string;
  created_at: string;
};

const toDto = (r: CommissionRow): CommissionPostingDto => ({
  id: r.id,
  agentUserId: r.agent_user_id,
  sourceType: r.source_type,
  sourceId: r.source_id,
  amount: r.amount,
  description: r.description,
  createdAt: r.created_at,
});

commissionsRouter.get('/commissions/me', requireAuth, (req, res) => {
  const database = getDb();
  const rows = database
    .prepare(
      `SELECT * FROM commission_postings
        WHERE agent_user_id = ?
        ORDER BY datetime(created_at) DESC
        LIMIT 200`,
    )
    .all(req.auth!.userId) as CommissionRow[];
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const now = new Date();
  const thisMonth = rows
    .filter((r) => {
      const d = new Date(r.created_at);
      return (
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth()
      );
    })
    .reduce((s, r) => s + r.amount, 0);
  return res.json({
    postings: rows.map(toDto),
    totals: {
      lifetime: Number(total.toFixed(2)),
      thisMonth: Number(thisMonth.toFixed(2)),
    },
  });
});
