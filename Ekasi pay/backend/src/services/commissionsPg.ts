import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { parseIntegerCents, type Cents } from '../money.js';

type DbClient = Pool | PoolClient;

export async function recordCommissionPostingPg(
  database: DbClient,
  opts: {
    agentUserId: string;
    sourceType: 'cash_send' | 'transfer' | 'sale' | 'manual';
    sourceId: string;
    amountCents: Cents;
    description: string;
    feeAssessmentId?: string;
    journalTransactionId?: string;
  },
): Promise<void> {
  const amountCents = parseIntegerCents(opts.amountCents);
  await database.query(
    `INSERT INTO commission_postings
       (id, agent_user_id, source_type, source_id, amount_cents, description,
        created_at, fee_assessment_id, journal_transaction_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      randomUUID(),
      opts.agentUserId,
      opts.sourceType,
      opts.sourceId,
      amountCents.toString(),
      opts.description,
      new Date().toISOString(),
      opts.feeAssessmentId ?? null,
      opts.journalTransactionId ?? null,
    ],
  );
}

export async function reverseCommissionPostingsPg(
  database: DbClient,
  sourceType: string,
  sourceId: string,
): Promise<void> {
  await database.query(
    `INSERT INTO commission_postings
       (id, agent_user_id, source_type, source_id, amount_cents, description,
        created_at, reversal_of_id)
     SELECT gen_random_uuid()::text, original.agent_user_id, original.source_type,
            original.source_id, -original.amount_cents,
            'REVERSAL: ' || original.description, clock_timestamp(), original.id
       FROM commission_postings original
      WHERE original.source_type = $1 AND original.source_id = $2
        AND original.reversal_of_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM commission_postings reversal
           WHERE reversal.reversal_of_id = original.id
        )`,
    [sourceType, sourceId],
  );
}
