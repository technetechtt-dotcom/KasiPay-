import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

type ComplianceSeverity = 'low' | 'medium' | 'high';

export function createComplianceFlag(
  database: Database.Database,
  input: {
    userId: string;
    reason: string;
    severity: ComplianceSeverity;
    transactionId?: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO compliance_flags
       (id, user_id, transaction_id, reason, severity, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?)`,
    )
    .run(
      randomUUID(),
      input.userId,
      input.transactionId ?? null,
      input.reason,
      input.severity,
      new Date().toISOString(),
    );
}
