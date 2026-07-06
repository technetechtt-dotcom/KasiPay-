export type RowUser = {
  id: string;
  name: string;
  phone: string;
  role: string;
  kyc_status: string;
  account_tier: string;
  created_at: string;
  country_code?: string;
  suspended_at?: string | null;
  deleted_at?: string | null;
};

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
    deletedAt: row.deleted_at ?? null,
  };
}

export function toComplianceFlag(row: {
  id: string;
  user_id: string;
  transaction_id: string | null;
  reason: string;
  severity: string;
  status: string;
  created_at: string;
}) {
  return {
    id: row.id,
    userId: row.user_id,
    transactionId: row.transaction_id,
    reason: row.reason,
    severity: row.severity,
    status: row.status,
    createdAt: row.created_at,
  };
}
