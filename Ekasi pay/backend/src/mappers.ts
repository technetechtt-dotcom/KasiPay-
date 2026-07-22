import type { RowUser } from './types.js';
import { formatCents, parseIntegerCents } from './money.js';

function decimalMoney(
  cents: string | undefined,
  legacy: number | undefined,
): string | number {
  return cents === undefined
    ? (legacy ?? (() => { throw new Error('Money column missing'); })())
    : formatCents(parseIntegerCents(cents, { allowZero: true, allowNegative: true }));
}

export function toPublicUser(row: RowUser) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    role: row.role,
    kycStatus: row.kyc_status,
    accountTier: row.account_tier,
    createdAt: row.created_at,
    countryCode: row.country_code ?? 'ZA',
    suspendedAt: row.suspended_at ?? null,
  };
}

export function toWallet(row: {
  id: string;
  user_id: string;
  balance?: number;
  balance_cents?: string;
  currency: string;
  status: string;
  pool_id?: string;
  wallet_kind?: string;
}) {
  return {
    id: row.id,
    userId: row.user_id,
    balance: decimalMoney(row.balance_cents, row.balance),
    currency: row.currency,
    status: row.status,
    poolId: row.pool_id ?? 'ZA',
    walletKind: (row.wallet_kind ?? 'user') as 'user' | 'system_escrow',
  };
}

export function toProduct(row: {
  id: string;
  merchant_id: string;
  name: string;
  cost_price?: number;
  price?: number;
  cost_price_cents?: string;
  price_cents?: string;
  stock: number;
  category: string;
  barcode: string | null;
}) {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    name: row.name,
    costPrice: decimalMoney(row.cost_price_cents, row.cost_price),
    price: decimalMoney(row.price_cents, row.price),
    stock: row.stock,
    category: row.category,
    ...(row.barcode ? { barcode: row.barcode } : {}),
  };
}

export function toTransaction(row: {
  id: string;
  from_wallet_id: string | null;
  to_wallet_id: string | null;
  amount?: number;
  amount_cents?: string;
  type: string;
  status: string;
  reference: string;
  description: string;
  created_at: string;
}) {
  return {
    id: row.id,
    fromWalletId: row.from_wallet_id,
    toWalletId: row.to_wallet_id,
    amount: decimalMoney(row.amount_cents, row.amount),
    type: row.type,
    status: row.status,
    reference: row.reference,
    description: row.description,
    createdAt: row.created_at,
  };
}

export function toExpense(row: {
  id: string;
  merchant_id: string;
  category: string;
  description: string;
  amount?: number;
  amount_cents?: string;
  created_at: string;
}) {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    category: row.category,
    description: row.description,
    amount: decimalMoney(row.amount_cents, row.amount),
    createdAt: row.created_at,
  };
}

export function toCreditCustomer(row: {
  id: string;
  merchant_id: string;
  name: string;
  phone: string;
  total_owed?: number;
  credit_limit?: number;
  total_owed_cents?: string;
  credit_limit_cents?: string;
  last_payment_date: string | null;
  created_at: string;
  sa_id_hash?: string | null;
  id_verified_at?: string | null;
}) {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    name: row.name,
    phone: row.phone,
    totalOwed: decimalMoney(row.total_owed_cents, row.total_owed),
    creditLimit: decimalMoney(row.credit_limit_cents, row.credit_limit),
    idVerified: Boolean(row.sa_id_hash),
    ...(row.last_payment_date
      ? { lastPaymentDate: row.last_payment_date }
      : {}),
    createdAt: row.created_at,
  };
}

export function toCreditTransaction(row: {
  id: string;
  customer_id: string;
  type: string;
  amount?: number;
  amount_cents?: string;
  description: string;
  created_at: string;
}) {
  return {
    id: row.id,
    customerId: row.customer_id,
    type: row.type,
    amount: decimalMoney(row.amount_cents, row.amount),
    description: row.description,
    createdAt: row.created_at,
  };
}

export function toLedgerEntry(row: {
  id: string;
  transaction_id: string;
  account_id: string;
  entry_type: string;
  amount?: number;
  balance_after?: number;
  amount_cents?: string;
  balance_after_cents?: string;
  created_at: string;
}) {
  return {
    id: row.id,
    transactionId: row.transaction_id,
    accountId: row.account_id,
    entryType: row.entry_type as 'debit' | 'credit',
    amount: decimalMoney(row.amount_cents, row.amount),
    balanceAfter: decimalMoney(row.balance_after_cents, row.balance_after),
    createdAt: row.created_at,
  };
}

export type MerchantApprovalStatus =
  | 'pending_docs'
  | 'pending_approval'
  | 'approved'
  | 'rejected';

export function toMerchant(row: {
  id: string;
  user_id: string;
  business_name: string;
  location: string;
  category: string;
  approval_status?: string | null;
  rejection_reason?: string | null;
  reviewed_at?: string | Date | null;
  reviewed_by?: string | null;
  docs_submitted_at?: string | Date | null;
}) {
  const approvalStatus = (row.approval_status ??
    'approved') as MerchantApprovalStatus;
  return {
    id: row.id,
    userId: row.user_id,
    businessName: row.business_name,
    location: row.location,
    category: row.category,
    approvalStatus,
    rejectionReason: row.rejection_reason ?? null,
    reviewedAt:
      row.reviewed_at == null ? null : (
        typeof row.reviewed_at === 'string' ?
          row.reviewed_at
        : row.reviewed_at.toISOString()
      ),
    reviewedBy: row.reviewed_by ?? null,
    docsSubmittedAt:
      row.docs_submitted_at == null ? null : (
        typeof row.docs_submitted_at === 'string' ?
          row.docs_submitted_at
        : row.docs_submitted_at.toISOString()
      ),
  };
}
