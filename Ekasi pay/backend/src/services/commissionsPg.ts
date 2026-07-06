import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

type DbClient = Pool | PoolClient;

export async function recordCommissionPostingPg(
  database: DbClient,
  opts: {
    agentUserId: string;
    sourceType: 'cash_send' | 'transfer' | 'sale' | 'manual';
    sourceId: string;
    amount: number;
    description: string;
  },
): Promise<void> {
  if (!Number.isFinite(opts.amount) || opts.amount <= 0) return;
  await database.query(
    `INSERT INTO commission_postings
       (id, agent_user_id, source_type, source_id, amount, description, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      randomUUID(),
      opts.agentUserId,
      opts.sourceType,
      opts.sourceId,
      Number(opts.amount.toFixed(2)),
      opts.description,
      new Date().toISOString(),
    ],
  );
}

export async function reverseCommissionPostingsPg(
  database: DbClient,
  sourceType: string,
  sourceId: string,
): Promise<void> {
  await database.query(
    `DELETE FROM commission_postings
      WHERE source_type = $1 AND source_id = $2`,
    [sourceType, sourceId],
  );
}
