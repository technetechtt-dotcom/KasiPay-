import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

export const WALLET_KINDS = ['user', 'merchant_sales', 'merchant_float', 'system_escrow'] as const;
export type WalletKind = (typeof WALLET_KINDS)[number];

type Db = Pool | PoolClient;

export type WalletRef = {
  id: string;
  user_id: string;
  status: string;
  currency: string;
  pool_id: string | null;
  wallet_kind: string;
  balance_cents?: string;
};

const SALES_SOURCES = new Set(['user']);
const SALES_DESTS = new Set(['user', 'merchant_sales']);
const FLOAT_ONLY = new Set(['merchant_float']);
const ESCROW = new Set(['system_escrow']);

export function assertWalletKindPair(
  fromKind: string,
  toKind: string,
  purpose:
    | 'consumer_to_merchant'
    | 'consumer_to_consumer'
    | 'merchant_internal_transfer'
    | 'cash_send_hold'
    | 'cash_send_payout'
    | 'float_credit'
    | 'float_debit',
): void {
  const from = fromKind || 'user';
  const to = toKind || 'user';
  const ok =
    (purpose === 'consumer_to_merchant' && SALES_SOURCES.has(from) && SALES_DESTS.has(to)) ||
    (purpose === 'consumer_to_consumer' && from === 'user' && to === 'user') ||
    (purpose === 'merchant_internal_transfer' &&
      (from === 'merchant_sales' || from === 'user') &&
      (to === 'merchant_sales' || to === 'merchant_float' || to === 'user')) ||
    (purpose === 'cash_send_hold' && FLOAT_ONLY.has(from) && ESCROW.has(to)) ||
    (purpose === 'cash_send_payout' && ESCROW.has(from) && FLOAT_ONLY.has(to)) ||
    (purpose === 'float_credit' && ESCROW.has(from) && FLOAT_ONLY.has(to)) ||
    (purpose === 'float_debit' && FLOAT_ONLY.has(from) && (ESCROW.has(to) || to === 'user'));
  if (!ok) {
    throw Object.assign(
      new Error(`Wallet kinds ${from} → ${to} are not allowed for ${purpose}`),
      { status: 400, code: 'WALLET_KIND_FORBIDDEN' },
    );
  }
}

export async function getCustomerWalletPg(database: Db, userId: string): Promise<WalletRef | null> {
  const q = await database.query<WalletRef>(
    `SELECT id, user_id, status, currency, pool_id, wallet_kind, balance_cents
       FROM wallets
      WHERE user_id = $1 AND COALESCE(wallet_kind, 'user') = 'user'
      LIMIT 1`,
    [userId],
  );
  return q.rows[0] ?? null;
}

export async function getMerchantSalesWalletPg(
  database: Db,
  userId: string,
): Promise<WalletRef | null> {
  const q = await database.query<WalletRef>(
    `SELECT id, user_id, status, currency, pool_id, wallet_kind, balance_cents
       FROM wallets
      WHERE user_id = $1 AND COALESCE(wallet_kind, 'user') IN ('merchant_sales', 'user')
      ORDER BY CASE COALESCE(wallet_kind, 'user') WHEN 'merchant_sales' THEN 0 ELSE 1 END
      LIMIT 1`,
    [userId],
  );
  return q.rows[0] ?? null;
}

export async function getMerchantFloatWalletPg(
  database: Db,
  userId: string,
): Promise<WalletRef | null> {
  const q = await database.query<WalletRef>(
    `SELECT id, user_id, status, currency, pool_id, wallet_kind, balance_cents
       FROM wallets
      WHERE user_id = $1 AND wallet_kind = 'merchant_float'
      LIMIT 1`,
    [userId],
  );
  return q.rows[0] ?? null;
}

export async function ensureMerchantFloatWalletPg(
  database: Db,
  userId: string,
  poolId = 'ZA',
  currency = 'ZAR',
): Promise<WalletRef> {
  const existing = await getMerchantFloatWalletPg(database, userId);
  if (existing) return existing;
  const sales = await getMerchantSalesWalletPg(database, userId);
  const id = randomUUID();
  await database.query(
    `INSERT INTO wallets (id, user_id, balance_cents, currency, status, pool_id, wallet_kind)
     VALUES ($1, $2, 0, $3, 'active', $4, 'merchant_float')`,
    [id, userId, sales?.currency ?? currency, sales?.pool_id ?? poolId],
  );
  const created = await getMerchantFloatWalletPg(database, userId);
  if (!created) throw new Error('Failed to create merchant float wallet');
  return created;
}
