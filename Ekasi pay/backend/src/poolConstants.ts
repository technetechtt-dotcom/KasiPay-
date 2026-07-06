/** Pool id matches country ISO 3166-1 alpha-2 for now (one pool per country). */
export const DEFAULT_POOL_ID = 'ZA';

/** Sentinel user identity backing the pooled escrow ledger row (ZA). */
export const ESCROW_SYSTEM_USER_ID_ZA = 'kasipay-system-escrow-za';

/** Must not collide with real MSISDNs — internal only, login blocked via `is_system`. */
export const ESCROW_SYSTEM_USER_PHONE_ZA = '__kp_escrow_ZA_v1';

const POOL_DEFAULT_CURRENCY: Record<string, string> = {
  ZA: 'ZAR',
};

export function currencyForPool(poolId: string): string {
  return POOL_DEFAULT_CURRENCY[poolId.toUpperCase()] ?? 'ZAR';
}
