import type { RowUser } from './types.js';

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
  balance: number;
  currency: string;
  status: string;
  pool_id?: string;
  wallet_kind?: string;
}) {
  return {
    id: row.id,
    userId: row.user_id,
    balance: row.balance,
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
  cost_price: number;
  price: number;
  stock: number;
  category: string;
  barcode: string | null;
}) {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    name: row.name,
    costPrice: row.cost_price,
    price: row.price,
    stock: row.stock,
    category: row.category,
    ...(row.barcode ? { barcode: row.barcode } : {}),
  };
}

export function toTransaction(row: {
  id: string;
  from_wallet_id: string | null;
  to_wallet_id: string | null;
  amount: number;
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
    amount: row.amount,
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
  amount: number;
  created_at: string;
}) {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    category: row.category,
    description: row.description,
    amount: row.amount,
    createdAt: row.created_at,
  };
}

export function toCreditCustomer(row: {
  id: string;
  merchant_id: string;
  name: string;
  phone: string;
  total_owed: number;
  credit_limit: number;
  last_payment_date: string | null;
  created_at: string;
}) {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    name: row.name,
    phone: row.phone,
    totalOwed: row.total_owed,
    creditLimit: row.credit_limit,
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
  amount: number;
  description: string;
  created_at: string;
}) {
  return {
    id: row.id,
    customerId: row.customer_id,
    type: row.type,
    amount: row.amount,
    description: row.description,
    createdAt: row.created_at,
  };
}

export function toLedgerEntry(row: {
  id: string;
  transaction_id: string;
  account_id: string;
  entry_type: string;
  amount: number;
  balance_after: number;
  created_at: string;
}) {
  return {
    id: row.id,
    transactionId: row.transaction_id,
    accountId: row.account_id,
    entryType: row.entry_type as 'debit' | 'credit',
    amount: row.amount,
    balanceAfter: row.balance_after,
    createdAt: row.created_at,
  };
}

export function toMerchant(row: {
  id: string;
  user_id: string;
  business_name: string;
  location: string;
  category: string;
}) {
  return {
    id: row.id,
    userId: row.user_id,
    businessName: row.business_name,
    location: row.location,
    category: row.category,
  };
}
