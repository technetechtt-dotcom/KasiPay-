import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { parseIntegerCents, type Cents } from '../money.js';
import { currentPaymentIdempotency } from '../middleware/idempotencyPg.js';
import { observeMetric } from '../observability.js';

const RETRYABLE_PG_CODES = new Set(['40001', '40P01']);
const MAX_POSTING_ATTEMPTS = 3;

type WalletRow = {
  id: string;
  balance_cents: string;
  currency: string;
  pool_id: string;
  status: string;
};

export type WalletPostingOptions = {
  fromWalletId: string;
  toWalletId: string;
  amountCents: Cents;
  type: string;
  referencePrefix: string;
  description: string;
  reference?: string;
  effectiveAt?: Date;
  settlementDueAt?: Date;
  actorId?: string;
  originalTransactionId?: string;
  reversalKind?: 'full' | 'partial' | 'refund';
};

function accountId(walletId: string): string {
  return `wallet:${walletId}`;
}

async function ensureWalletAccount(
  database: PoolClient,
  wallet: WalletRow,
): Promise<string> {
  const id = accountId(wallet.id);
  await database.query(
    `INSERT INTO ledger_accounts
       (id, code, name, account_class, normal_side, currency, pool_id, wallet_id)
     VALUES ($1, $2, $3, 'liability', 'credit', $4, $5, $6)
     ON CONFLICT (wallet_id) DO NOTHING`,
    [id, `WALLET-${wallet.id}`, `Wallet ${wallet.id}`, wallet.currency, wallet.pool_id, wallet.id],
  );
  const resolved = await database.query<{ id: string }>(
    `SELECT id FROM ledger_accounts WHERE wallet_id = $1`,
    [wallet.id],
  );
  const resolvedId = resolved.rows[0]?.id;
  if (!resolvedId) throw new Error(`Ledger account missing for wallet ${wallet.id}`);
  await database.query(
    `INSERT INTO account_balance_projections(account_id, available_cents)
     VALUES ($1, $2) ON CONFLICT (account_id) DO NOTHING`,
    [resolvedId, wallet.balance_cents],
  );
  return resolvedId;
}

async function lockWallets(
  database: PoolClient,
  walletIds: readonly string[],
): Promise<Map<string, WalletRow>> {
  const result = await database.query<WalletRow>(
    `SELECT id, balance_cents, currency, COALESCE(pool_id, 'ZA') AS pool_id, status
       FROM wallets
      WHERE id = ANY($1::text[])
      ORDER BY id
      FOR UPDATE`,
    [[...walletIds].sort()],
  );
  if (result.rows.length !== new Set(walletIds).size) {
    throw Object.assign(new Error('Wallet missing'), { status: 400 });
  }
  return new Map(result.rows.map((row) => [row.id, row]));
}

async function postLocked(
  database: PoolClient,
  opts: WalletPostingOptions,
): Promise<{ transactionId: string; reference: string }> {
  const amountCents = parseIntegerCents(opts.amountCents);
  if (opts.fromWalletId === opts.toWalletId) {
    throw Object.assign(new Error('Cannot move to the same wallet'), { status: 400 });
  }

  const wallets = await lockWallets(database, [opts.fromWalletId, opts.toWalletId]);
  const from = wallets.get(opts.fromWalletId)!;
  const to = wallets.get(opts.toWalletId)!;
  if (from.status !== 'active' || to.status !== 'active') {
    throw Object.assign(new Error('Wallet inactive'), { status: 400 });
  }
  if (from.currency !== to.currency || from.pool_id !== to.pool_id) {
    throw Object.assign(new Error('Wallet currency/pool mismatch'), { status: 400 });
  }
  if (parseIntegerCents(from.balance_cents, { allowZero: true }) < amountCents) {
    throw Object.assign(new Error('Insufficient balance'), { status: 400 });
  }

  const [fromAccountId, toAccountId] = await Promise.all([
    ensureWalletAccount(database, from),
    ensureWalletAccount(database, to),
  ]);
  await database.query(
    `SELECT account_id FROM account_balance_projections
      WHERE account_id = ANY($1::text[]) ORDER BY account_id FOR UPDATE`,
    [[fromAccountId, toAccountId].sort()],
  );

  const transactionId = randomUUID();
  const batchId = randomUUID();
  const now = new Date();
  const reference =
    opts.reference ?? `${opts.referencePrefix}-${transactionId.slice(0, 8).toUpperCase()}`;
  await database.query(
    `INSERT INTO posting_batches(id, source, actor_id, state)
     VALUES ($1, $2, $3, 'authorized')`,
    [batchId, opts.type, opts.actorId ?? null],
  );
  await database.query(
    `INSERT INTO journal_transactions
       (id, batch_id, reference, transaction_type, description, currency, pool_id,
        state, original_transaction_id, reversal_kind, effective_at, settlement_due_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'authorized',$8,$9,$10,$11)`,
    [
      transactionId,
      batchId,
      reference,
      opts.type,
      opts.description,
      from.currency,
      from.pool_id,
      opts.originalTransactionId ?? null,
      opts.reversalKind ?? null,
      (opts.effectiveAt ?? now).toISOString(),
      opts.settlementDueAt?.toISOString() ?? null,
    ],
  );
  await database.query(
    `INSERT INTO journal_entries(id, transaction_id, account_id, side, amount_cents, currency)
     VALUES ($1,$2,$3,'debit',$4,$5), ($6,$2,$7,'credit',$4,$5)`,
    [
      randomUUID(),
      transactionId,
      fromAccountId,
      amountCents.toString(),
      from.currency,
      randomUUID(),
      toAccountId,
    ],
  );

  const debit = await database.query<{ available_cents: string }>(
    `UPDATE account_balance_projections
        SET available_cents = available_cents - $1, version = version + 1,
            updated_at = clock_timestamp()
      WHERE account_id = $2 AND available_cents >= $1
      RETURNING available_cents`,
    [amountCents.toString(), fromAccountId],
  );
  if (!debit.rows[0]) {
    throw Object.assign(new Error('Insufficient balance'), { status: 400 });
  }
  const credit = await database.query<{ available_cents: string }>(
    `UPDATE account_balance_projections
        SET available_cents = available_cents + $1, version = version + 1,
            updated_at = clock_timestamp()
      WHERE account_id = $2 RETURNING available_cents`,
    [amountCents.toString(), toAccountId],
  );

  await database.query(
    `UPDATE wallets SET balance_cents = CASE id
       WHEN $2 THEN balance_cents - $1::bigint
       WHEN $3 THEN balance_cents + $1::bigint END
     WHERE id IN ($2, $3)`,
    [amountCents.toString(), from.id, to.id],
  );
  await database.query(
    `UPDATE journal_transactions SET state = 'posted', posted_at = $2 WHERE id = $1`,
    [transactionId, now.toISOString()],
  );
  await database.query(
    `UPDATE posting_batches SET state = 'posted', posted_at = $2 WHERE id = $1`,
    [batchId, now.toISOString()],
  );
  const idempotency = currentPaymentIdempotency();
  if (idempotency) {
    await database.query(
      `UPDATE payment_idempotency
          SET posting_id = COALESCE(posting_id, $1),
              financial_reference = COALESCE(financial_reference, $2),
              updated_at = clock_timestamp()
        WHERE actor_id = $3 AND route = $4 AND client_key = $5
          AND request_hash = $6 AND lifecycle = 'in_flight'`,
      [
        transactionId,
        reference,
        idempotency.actorId,
        idempotency.route,
        idempotency.key,
        idempotency.requestHash,
      ],
    );
  }

  // Compatibility projection for existing API mappers. The journal is authoritative.
  await database.query(
    `INSERT INTO transactions
       (id, from_wallet_id, to_wallet_id, amount_cents, type, status, reference, description, created_at)
     VALUES ($1,$2,$3,$4,$5,'completed',$6,$7,$8)`,
    [
      transactionId,
      from.id,
      to.id,
      amountCents.toString(),
      opts.type,
      reference,
      opts.description,
      now.toISOString(),
    ],
  );
  await database.query(
    `INSERT INTO ledger_entries
       (id, transaction_id, account_id, entry_type, amount_cents, balance_after_cents, created_at)
     VALUES ($1,$2,$3,'debit',$4,$5,$6), ($7,$2,$8,'credit',$4,$9,$6)`,
    [
      randomUUID(),
      transactionId,
      from.id,
      amountCents.toString(),
      debit.rows[0].available_cents,
      now.toISOString(),
      randomUUID(),
      to.id,
      credit.rows[0]?.available_cents,
    ],
  );
  observeMetric('posting.success');
  return { transactionId, reference };
}

/**
 * Atomic wallet-to-wallet posting inside an open transaction.
 * Callers must pass a PoolClient after BEGIN — never a Pool — so FOR UPDATE
 * locks and journal writes share one transaction.
 */
export async function postBetweenWalletsPg(
  database: PoolClient,
  opts: WalletPostingOptions,
): Promise<{ transactionId: string; reference: string }> {
  return postLocked(database, opts);
}

/** Owns the transaction and retries only PostgreSQL serialization/deadlock failures. */
export async function postBetweenWalletsWithRetryPg(
  pool: Pool,
  opts: WalletPostingOptions,
): Promise<{ transactionId: string; reference: string }> {
  for (let attempt = 1; ; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const result = await postLocked(client, opts);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      observeMetric('posting.failure');
      const code = (error as { code?: string }).code;
      if (!code || !RETRYABLE_PG_CODES.has(code) || attempt >= MAX_POSTING_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, 15 * 2 ** (attempt - 1)));
    } finally {
      client.release();
    }
  }
}

export async function reverseWalletPostingPg(
  database: PoolClient,
  opts: {
    originalTransactionId: string;
    amountCents?: Cents;
    kind?: 'full' | 'partial' | 'refund';
    referencePrefix?: string;
    description: string;
    actorId?: string;
  },
): Promise<{ transactionId: string; reference: string }> {
  const original = await database.query<{
    id: string;
    state: string;
    from_wallet_id: string;
    to_wallet_id: string;
    amount_cents: string;
  }>(
    `SELECT j.id, j.state, t.from_wallet_id, t.to_wallet_id, t.amount_cents
       FROM journal_transactions j JOIN transactions t ON t.id = j.id::text
      WHERE j.id = $1 FOR UPDATE`,
    [opts.originalTransactionId],
  );
  const row = original.rows[0];
  if (!row || !['posted', 'settled'].includes(row.state)) {
    throw Object.assign(new Error('Original posting is not reversible'), { status: 409 });
  }
  const originalCents = parseIntegerCents(row.amount_cents);
  const already = await database.query<{ total: string }>(
    `SELECT COALESCE(sum(e.amount_cents), 0)::text AS total
       FROM journal_transactions r
       JOIN journal_entries e ON e.transaction_id = r.id AND e.side = 'debit'
      WHERE r.original_transaction_id = $1 AND r.state IN ('posted','settled')`,
    [row.id],
  );
  const reversedCents = BigInt(already.rows[0]?.total ?? '0');
  const amount = opts.amountCents ? parseIntegerCents(opts.amountCents) : originalCents - reversedCents;
  if (amount <= 0n || reversedCents + amount > originalCents) {
    throw Object.assign(new Error('Refund exceeds unreversed amount'), { status: 409 });
  }
  return postLocked(database, {
    fromWalletId: row.to_wallet_id,
    toWalletId: row.from_wallet_id,
    amountCents: amount as Cents,
    type: opts.kind === 'refund' ? 'refund' : 'reversal',
    referencePrefix: opts.referencePrefix ?? 'REV',
    description: opts.description,
    actorId: opts.actorId,
    originalTransactionId: row.id,
    reversalKind:
      opts.kind ?? (amount === originalCents ? 'full' : 'partial'),
  });
}
