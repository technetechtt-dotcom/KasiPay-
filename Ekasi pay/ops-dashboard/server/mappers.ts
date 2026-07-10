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

export type RowCashSendVoucher = {
  id: string;
  reference_number: string;
  status: string;
  amount: number;
  fee: number;
  created_at: string;
  expires_at: string;
  collected_at: string | null;
  cancel_reason?: string | null;
  sender_user_id?: string | null;
  sender_address?: string | null;
  recipient_first_name?: string | null;
  recipient_last_name?: string | null;
  recipient_name?: string | null;
  recipient_phone: string;
  recipient_id_document?: string | null;
  collector_scanned_id?: string | null;
  collected_with_id_verified?: number | null;
  sender_first_name?: string | null;
  sender_last_name?: string | null;
  sender_name?: string | null;
  sender_phone: string;
  sender_id_document?: string | null;
};

function splitLegacyName(name: string | null | undefined): {
  firstName: string;
  lastName: string;
} {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

function digitsOnly(id: string | null | undefined): string | null {
  const digits = (id ?? '').replace(/\D/g, '');
  return digits.length > 0 ? digits : null;
}

/** Ops view of a Cash Send voucher with full sender / beneficiary / collection details. */
export function toOpsCashSendVoucher(row: RowCashSendVoucher) {
  const recipientLegacy = splitLegacyName(row.recipient_name);
  const withdrawerFirstName =
    (row.recipient_first_name ?? '').trim() || recipientLegacy.firstName;
  const withdrawerLastName =
    (row.recipient_last_name ?? '').trim() || recipientLegacy.lastName;

  const senderLegacy = splitLegacyName(row.sender_name);
  const senderFirstName =
    (row.sender_first_name ?? '').trim() || senderLegacy.firstName;
  const senderLastName =
    (row.sender_last_name ?? '').trim() || senderLegacy.lastName;

  const scanned = digitsOnly(row.collector_scanned_id);
  const onFile = digitsOnly(row.recipient_id_document);
  const senderId = digitsOnly(row.sender_id_document);

  return {
    id: row.id,
    referenceNumber: row.reference_number,
    status: row.status,
    amount: Number(row.amount),
    fee: Number(row.fee),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    collectedAt: row.collected_at,
    withdrawnAt: row.collected_at,
    cancelReason: row.cancel_reason ?? null,
    senderUserId: row.sender_user_id ?? null,
    senderAddress: (row.sender_address ?? '').trim() || null,
    sender: {
      firstName: senderFirstName,
      lastName: senderLastName,
      phone: row.sender_phone,
      idDocument: senderId,
    },
    withdrawer: {
      firstName: withdrawerFirstName,
      lastName: withdrawerLastName,
      phone: row.recipient_phone,
      idDocument: scanned ?? onFile,
    },
    recipientIdOnFile: onFile,
    collectorScannedId: scanned,
    idVerifiedAtWithdrawal: row.collected_with_id_verified === 1,
  };
}
