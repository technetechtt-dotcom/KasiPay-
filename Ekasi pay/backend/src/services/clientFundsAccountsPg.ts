import type { Pool, PoolClient } from 'pg';

type Db = Pool | PoolClient;

export function clientFundsBankLedgerAccountId(poolId: string, currency: string): string {
  if (poolId === 'ZA' && currency === 'ZAR') return 'system:safeguarded-cash:zar';
  return `bank:client_funds:${poolId}:${currency}`;
}

export async function isApprovedClientFundsDestinationPg(
  database: Db,
  input: {
    destinationAccount?: string | null;
    currency: string;
    poolId?: string;
  },
): Promise<boolean> {
  const fingerprint = input.destinationAccount?.trim();
  if (!fingerprint) return false;
  const row = await database.query<{ id: string }>(
    `SELECT ba.id
       FROM bank_accounts ba
       JOIN safeguarding_accounts sa ON sa.bank_account_id = ba.id
      WHERE ba.account_fingerprint = $1
        AND ba.purpose = 'client_funds'
        AND ba.approved = TRUE
        AND ba.currency = $2
        AND ba.pool_id = $3
        AND sa.currency = $2
        AND sa.pool_id = $3
      LIMIT 1`,
    [fingerprint, input.currency, input.poolId ?? 'ZA'],
  );
  return Boolean(row.rows[0]);
}
