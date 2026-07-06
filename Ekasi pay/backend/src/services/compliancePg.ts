import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

type DbClient = Pool | PoolClient;

type ComplianceSeverity = 'low' | 'medium' | 'high';

export async function createComplianceFlagPg(
  pool: DbClient,
  input: {
    userId: string;
    reason: string;
    severity: ComplianceSeverity;
    transactionId?: string;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO compliance_flags
      (id, user_id, transaction_id, reason, severity, status, created_at)
     VALUES ($1, $2, $3, $4, $5, 'open', $6)`,
    [
      randomUUID(),
      input.userId,
      input.transactionId ?? null,
      input.reason,
      input.severity,
      new Date().toISOString(),
    ],
  );
}
