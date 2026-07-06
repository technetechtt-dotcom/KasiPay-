import { describe, expect, it } from 'vitest';

import { digitsFromBarcodeForSaId } from './scannerSession';
import { MERCHANT_PORTAL_PAGE_IDS } from '../config/merchantPortalPages';

describe('digitsFromBarcodeForSaId', () => {
  it('returns a plain 13-digit ID from Code128-style payloads', () => {
    expect(digitsFromBarcodeForSaId('8001015009087')).toBe('8001015009087');
  });

  it('extracts the ID from PDF417-style text with extra fields', () => {
    const pdf417Like =
      'SURNAME|JOHN|8001015009087|RSA|1990-01-01|1990010150087';
    expect(digitsFromBarcodeForSaId(pdf417Like)).toBe('8001015009087');
  });

  it('prefers a checksum-valid candidate when multiple 13-digit runs exist', () => {
    const noisy = '99999999999998001015009087';
    expect(digitsFromBarcodeForSaId(noisy)).toBe('8001015009087');
  });

  it('picks the better-scored ID when several checksum-valid runs exist', () => {
    const bothValid = '80010150090879001015009086';
    expect(digitsFromBarcodeForSaId(bothValid)).toBe('8001015009087');
  });

  it('strips spaces and punctuation', () => {
    expect(digitsFromBarcodeForSaId('8001 0150 0908 7')).toBe('8001015009087');
  });
});

describe('MERCHANT_PORTAL_PAGE_IDS', () => {
  it('does not block wallet-mode Cash Send ID scans', () => {
    expect(MERCHANT_PORTAL_PAGE_IDS.has('scanner')).toBe(false);
  });
});
