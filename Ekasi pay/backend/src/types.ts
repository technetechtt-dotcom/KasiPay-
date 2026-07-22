export type RowUser = {
  id: string;
  name: string;
  phone: string;
  pin_hash: string;
  role: string;
  kyc_status: string;
  account_tier: string;
  created_at: string;
  country_code?: string;
  /** 1 = internal escrow / system identity — must not authenticate as a human user */
  is_system?: number;
  /** Soft-delete marker. When set, login/refresh refuse the row. */
  deleted_at?: string | null;
  /** Admin suspension marker. When set, login/refresh/auth refuse the row. */
  suspended_at?: string | null;
  token_version?: number;
};
