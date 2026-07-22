import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { parseIntegerCents, type Cents } from '../money.js';

export type DriftOrigin =
  | 'opening_credit_without_ledger'
  | 'legacy_dual_write_gap'
  | 'escrow_fee_retention_mismatch'
  | 'integration_fixture'
  | 'unknown';

export type DriftRow = {
  walletId: string;
  userId: string;
  walletKind: string;
  balanceCents: bigint;
  legacyLedgerCents: bigint;
  deltaCents: bigint;
  legacyEntryCount: number;
  origin: DriftOrigin;
};

function suspenseAccountId(currency: string, poolId: string): string {
  if (currency === 'ZAR' && poolId === 'ZA') return 'system:suspense:zar';
  throw new Error(`No approved suspense account for ${currency}/${poolId}.`);
}

export function classifyDriftOrigin(row: {
  walletId: string;
  walletKind: string;
  deltaCents: bigint;
  legacyEntryCount: number;
}): DriftOrigin {
  if (row.walletId.startsWith('ledger-wallet-from-')) return 'integration_fixture';
  if (
    row.walletKind === 'system_escrow' &&
    (row.deltaCents === -2000n || row.deltaCents === 2000n)
  ) {
    return 'escrow_fee_retention_mismatch';
  }
  if (row.legacyEntryCount === 0 && row.deltaCents > 0n) {
    return 'opening_credit_without_ledger';
  }
  if (row.deltaCents === 100001000n || row.deltaCents === -100001000n) {
    return 'opening_credit_without_ledger';
  }
  if (row.legacyEntryCount > 0 && row.deltaCents !== 0n) {
    return 'legacy_dual_write_gap';
  }
  return 'unknown';
}

/**
 * Bring legacy ledger + journal projection into agreement with wallets.balance_cents
 * without editing the wallet row directly. Posts a balanced journal against suspense.
 *
 * delta = wallet - ledger
 *  - delta > 0: Dr suspense, Cr wallet liability (books catch up to wallet)
 *  - delta < 0: Dr wallet liability, Cr suspense (books reduced to wallet)
 */
export async function alignLegacyLedgerToWalletPg(
  database: PoolClient,
  input: {
    walletId: string;
    approvalReference: string;
    actorId?: string;
    reason: string;
  },
): Promise<{ transactionId: string; reference: string; deltaCents: string }> {
  const wallet = await database.query<{
    id: string;
    balance_cents: string;
    currency: string;
    pool_id: string;
    status: string;
  }>(
    `SELECT id, balance_cents, currency, COALESCE(pool_id, 'ZA') AS pool_id, status
       FROM wallets WHERE id = $1 FOR UPDATE`,
    [input.walletId],
  );
  const row = wallet.rows[0];
  if (!row) throw Object.assign(new Error('Wallet missing'), { status: 404 });
  if (row.status !== 'active' && row.status !== 'frozen') {
    throw Object.assign(new Error('Wallet status blocks alignment'), { status: 409 });
  }

  const ledger = await database.query<{ ledger_cents: string }>(
    `SELECT COALESCE(sum(CASE entry_type
            WHEN 'credit' THEN amount_cents
            WHEN 'debit' THEN -amount_cents
            ELSE 0 END), 0)::text AS ledger_cents
       FROM ledger_entries WHERE account_id = $1`,
    [row.id],
  );
  const balanceCents = parseIntegerCents(row.balance_cents, { allowZero: true });
  const ledgerCents = BigInt(ledger.rows[0]?.ledger_cents ?? '0');
  const delta = balanceCents - ledgerCents;
  if (delta === 0n) {
    return { transactionId: '', reference: '', deltaCents: '0' };
  }

  const amount = (delta < 0n ? -delta : delta) as Cents;
  const suspenseId = suspenseAccountId(row.currency, row.pool_id);
  const walletAccountId = `wallet:${row.id}`;

  await database.query(
    `INSERT INTO ledger_accounts
       (id, code, name, account_class, normal_side, currency, pool_id, wallet_id)
     VALUES ($1, $2, $3, 'liability', 'credit', $4, $5, $6)
     ON CONFLICT (wallet_id) DO NOTHING`,
    [
      walletAccountId,
      `WALLET-${row.id}`,
      `Wallet ${row.id}`,
      row.currency,
      row.pool_id,
      row.id,
    ],
  );
  const resolved = await database.query<{ id: string }>(
    `SELECT id FROM ledger_accounts WHERE wallet_id = $1`,
    [row.id],
  );
  const accountId = resolved.rows[0]?.id ?? walletAccountId;
  await database.query(
    `INSERT INTO account_balance_projections(account_id, available_cents)
     VALUES ($1, $2) ON CONFLICT (account_id) DO NOTHING`,
    [accountId, '0'],
  );
  await database.query(
    `INSERT INTO account_balance_projections(account_id, available_cents)
     VALUES ($1, 0) ON CONFLICT (account_id) DO NOTHING`,
    [suspenseId],
  );
  await database.query(
    `SELECT account_id FROM account_balance_projections
      WHERE account_id = ANY($1::text[]) ORDER BY account_id FOR UPDATE`,
    [[accountId, suspenseId].sort()],
  );

  const transactionId = randomUUID();
  const batchId = randomUUID();
  const reference = `ALIGN-${transactionId.slice(0, 8).toUpperCase()}`;
  const debitAccount = delta > 0n ? suspenseId : accountId;
  const creditAccount = delta > 0n ? accountId : suspenseId;

  await database.query(
    `INSERT INTO posting_batches(id, source, actor_id, state)
     VALUES ($1, 'balance_adjustment', $2, 'authorized')`,
    [batchId, input.actorId ?? null],
  );
  await database.query(
    `INSERT INTO journal_transactions
       (id, batch_id, reference, transaction_type, description, currency, pool_id,
        state, effective_at, posted_at, metadata)
     VALUES ($1,$2,$3,'balance_adjustment',$4,$5,$6,'posted',
             clock_timestamp(), clock_timestamp(), $7::jsonb)`,
    [
      transactionId,
      batchId,
      reference,
      input.reason,
      row.currency,
      row.pool_id,
      JSON.stringify({
        approvalReference: input.approvalReference,
        walletId: row.id,
        deltaCents: delta.toString(),
        alignTo: 'wallet',
      }),
    ],
  );
  await database.query(
    `INSERT INTO journal_entries(id, transaction_id, account_id, side, amount_cents, currency)
     VALUES ($1,$2,$3,'debit',$4,$5), ($6,$2,$7,'credit',$4,$5)`,
    [
      randomUUID(),
      transactionId,
      debitAccount,
      amount.toString(),
      row.currency,
      randomUUID(),
      creditAccount,
    ],
  );

  // Projection may itself be drifted; snap wallet projection to the wallet balance
  // after the alignment journal and move the opposite side on suspense.
  if (delta > 0n) {
    await database.query(
      `UPDATE account_balance_projections
          SET available_cents = available_cents - $1, version = version + 1,
              updated_at = clock_timestamp()
        WHERE account_id = $2`,
      [amount.toString(), suspenseId],
    );
  } else {
    await database.query(
      `UPDATE account_balance_projections
          SET available_cents = available_cents + $1, version = version + 1,
              updated_at = clock_timestamp()
        WHERE account_id = $2`,
      [amount.toString(), suspenseId],
    );
  }
  await database.query(
    `UPDATE account_balance_projections
        SET available_cents = $1, version = version + 1,
            updated_at = clock_timestamp()
      WHERE account_id = $2`,
    [balanceCents.toString(), accountId],
  );

  // Compatibility transaction row required by legacy ledger_entries FK.
  // Wallet balances are intentionally unchanged by this alignment journal.
  await database.query(
    `INSERT INTO transactions
       (id, from_wallet_id, to_wallet_id, amount_cents, type, status, reference, description, created_at)
     VALUES ($1,$2,$3,$4,'balance_adjustment','completed',$5,$6,clock_timestamp())`,
    [
      transactionId,
      delta > 0n ? null : row.id,
      delta > 0n ? row.id : null,
      amount.toString(),
      reference,
      input.reason,
    ],
  );
  await database.query(
    `INSERT INTO ledger_entries
       (id, transaction_id, account_id, entry_type, amount_cents, balance_after_cents, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp())`,
    [
      randomUUID(),
      transactionId,
      row.id,
      delta > 0n ? 'credit' : 'debit',
      amount.toString(),
      balanceCents.toString(),
    ],
  );

  await database.query(
    `UPDATE posting_batches SET state = 'posted', posted_at = clock_timestamp() WHERE id = $1`,
    [batchId],
  );

  return { transactionId, reference, deltaCents: delta.toString() };
}

export async function inventoryWalletLedgerDriftPg(
  database: PoolClient,
): Promise<DriftRow[]> {
  const result = await database.query<{
    wallet_id: string;
    user_id: string;
    wallet_kind: string;
    balance_cents: string;
    legacy_ledger_cents: string;
    delta_cents: string;
    legacy_entry_count: number;
  }>(`
    WITH ledger AS (
      SELECT account_id,
             COALESCE(sum(CASE entry_type
               WHEN 'credit' THEN amount_cents
               WHEN 'debit' THEN -amount_cents
               ELSE 0 END), 0)::bigint AS ledger_cents,
             count(*)::int AS entry_count
        FROM ledger_entries
       GROUP BY account_id
    )
    SELECT w.id AS wallet_id,
           w.user_id,
           COALESCE(w.wallet_kind, 'user') AS wallet_kind,
           w.balance_cents::text AS balance_cents,
           COALESCE(l.ledger_cents, 0)::text AS legacy_ledger_cents,
           (w.balance_cents - COALESCE(l.ledger_cents, 0))::text AS delta_cents,
           COALESCE(l.entry_count, 0)::int AS legacy_entry_count
      FROM wallets w
      LEFT JOIN ledger l ON l.account_id = w.id
     WHERE w.balance_cents <> COALESCE(l.ledger_cents, 0)
     ORDER BY abs(w.balance_cents - COALESCE(l.ledger_cents, 0)) DESC, w.id
  `);

  return result.rows.map((row) => {
    const deltaCents = BigInt(row.delta_cents);
    return {
      walletId: row.wallet_id,
      userId: row.user_id,
      walletKind: row.wallet_kind,
      balanceCents: BigInt(row.balance_cents),
      legacyLedgerCents: BigInt(row.legacy_ledger_cents),
      deltaCents,
      legacyEntryCount: row.legacy_entry_count,
      origin: classifyDriftOrigin({
        walletId: row.wallet_id,
        walletKind: row.wallet_kind,
        deltaCents,
        legacyEntryCount: row.legacy_entry_count,
      }),
    };
  });
}
