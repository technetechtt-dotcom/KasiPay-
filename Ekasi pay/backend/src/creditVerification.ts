import { createHash, randomInt, randomUUID } from 'node:crypto';

import { PIN_RESET_PEPPER } from './config.js';
import {
  cashSendIdsMatch,
  normalizeCashSendId,
  validateSaIdDigits,
} from './cashSendKyc.js';

export const CREDIT_OTP_TTL_MS = 10 * 60_000;
export const CREDIT_VERIFY_TOKEN_TTL_MS = 5 * 60_000;

export type CreditOtpPurpose = 'onboard' | 'purchase';

export function normalizeCreditPhone(raw: string): string {
  return raw.replace(/\D/g, '');
}

export function parseSaIdDocument(raw: string): string | null {
  const digits = normalizeCashSendId(raw);
  return validateSaIdDigits(digits) ? digits : null;
}

export function hashSaIdForStorage(digits: string): string {
  return createHash('sha256')
    .update(`${PIN_RESET_PEPPER}:credit-sa-id:${digits}`)
    .digest('hex');
}

export function hashCreditOtp(params: {
  merchantId: string;
  phone: string;
  purpose: CreditOtpPurpose;
  customerId?: string;
  code: string;
}): string {
  return createHash('sha256')
    .update(
      `${PIN_RESET_PEPPER}:credit-otp:${params.merchantId}:${params.phone}:${params.purpose}:${params.customerId ?? ''}:${params.code}`,
    )
    .digest('hex');
}

export function generateCreditOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function generateCreditVerificationToken(): string {
  return randomUUID();
}

export function saIdsMatch(storedHash: string | null | undefined, presented: string): boolean {
  const digits = parseSaIdDocument(presented);
  if (!digits) return false;
  if (!storedHash) return true;
  return storedHash === hashSaIdForStorage(digits);
}

export function idsMatchHash(storedHash: string, presented: string): boolean {
  const digits = parseSaIdDocument(presented);
  if (!digits) return false;
  return storedHash === hashSaIdForStorage(digits);
}

export { cashSendIdsMatch };
