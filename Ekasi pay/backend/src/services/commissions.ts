import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

/**
 * Insert a single commission row. Call this inside the same DB transaction as
 * the fee-bearing event so commissions can never diverge from the underlying
 * activity (e.g. a refunded cash-send rolls its commission back automatically).
 */
export function recordCommissionPosting(
  database: Database.Database,
  opts: {
    agentUserId: string;
    sourceType: 'cash_send' | 'transfer' | 'sale' | 'manual';
    sourceId: string;
    amount: number;
    description: string;
  },
): void {
  if (!Number.isFinite(opts.amount) || opts.amount <= 0) return;
  database
    .prepare(
      `INSERT INTO commission_postings
         (id, agent_user_id, source_type, source_id, amount, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      opts.agentUserId,
      opts.sourceType,
      opts.sourceId,
      Number(opts.amount.toFixed(2)),
      opts.description,
      new Date().toISOString(),
    );
}

/** Reverse a commission tied to a source (e.g. cash-send refund-on-expire). */
export function reverseCommissionPostings(
  database: Database.Database,
  sourceType: string,
  sourceId: string,
): void {
  database
    .prepare(
      `DELETE FROM commission_postings
        WHERE source_type = ? AND source_id = ?`,
    )
    .run(sourceType, sourceId);
}
