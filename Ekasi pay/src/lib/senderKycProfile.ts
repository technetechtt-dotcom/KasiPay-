/**
 * Persisted Cash Send sender KYC profile. Once a merchant has successfully
 * sent a voucher we cache the sender first/last name, ID, and address so
 * subsequent vouchers prefill those four fields. The data is scoped per
 * phone number (the logged-in user) so a shared tablet that swaps users
 * doesn't leak one shopkeeper's ID into another's draft.
 *
 * Stored in `localStorage` because it must outlive a tab close. Cleared on
 * `clearSenderKycProfile()` (call from logout) so a shared device doesn't
 * carry stale identity data forward.
 */
const SENDER_KYC_KEY = 'kasiPay.senderKyc.v1';

export type SenderKycProfile = {
  /** Owner phone, used to scope per logged-in user. */
  phone: string;
  firstName: string;
  lastName: string;
  /** 13-digit South African ID — verified at last send. */
  idDocument: string;
  address: string;
  savedAt: string;
};

export function loadSenderKycProfile(phone: string): SenderKycProfile | null {
  if (typeof window === 'undefined' || !phone) return null;
  try {
    const raw = window.localStorage.getItem(SENDER_KYC_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SenderKycProfile> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.phone !== phone) return null;
    if (
      typeof parsed.firstName !== 'string' ||
      typeof parsed.lastName !== 'string' ||
      typeof parsed.idDocument !== 'string' ||
      typeof parsed.address !== 'string'
    ) {
      return null;
    }
    return {
      phone,
      firstName: parsed.firstName,
      lastName: parsed.lastName,
      idDocument: parsed.idDocument,
      address: parsed.address,
      savedAt: parsed.savedAt ?? new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

export function saveSenderKycProfile(p: SenderKycProfile): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SENDER_KYC_KEY, JSON.stringify(p));
  } catch {
    /* ignore quota / private-mode errors */
  }
}

export function clearSenderKycProfile(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(SENDER_KYC_KEY);
  } catch {
    /* ignore */
  }
}
