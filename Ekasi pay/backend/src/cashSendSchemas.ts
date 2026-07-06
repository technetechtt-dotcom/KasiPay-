import { z } from 'zod';

import { normalizeCashSendId, validateSaIdDigits } from './cashSendKyc.js';

/** Required at Cash Send create (sender KYC). */
export const saIdBody = z
  .string()
  .min(1)
  .transform((v) => normalizeCashSendId(v))
  .refine(
    (v) => validateSaIdDigits(v),
    'SA identity number must be 13 digits with a valid checksum',
  );

/**
 * Optional on create — beneficiary SA ID is captured when they collect cash,
 * not when the sender creates the voucher.
 */
export const optionalSaIdBody = z
  .string()
  .optional()
  .default('')
  .transform((v) => normalizeCashSendId(v ?? ''))
  .refine(
    (v) => v === '' || validateSaIdDigits(v),
    'SA identity number must be 13 digits with a valid checksum',
  );
