export const CASH_SEND_CONSENT_STORAGE_KEY = 'ekasi.cashSendDataConsent.v1';

export function hasCashSendDataConsent(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.localStorage.getItem(CASH_SEND_CONSENT_STORAGE_KEY) === '1'
  );
}
