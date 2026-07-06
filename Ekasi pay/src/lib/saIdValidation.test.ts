import { describe, expect, it } from 'vitest';

import {
  isValidSaIdChecksum,
  isValidSaIdDigits,
  saIdValidationMessage,
  scoreSaIdCandidate,
} from './saIdValidation';

describe('saIdValidation', () => {
  it('accepts a known-valid SA ID', () => {
    expect(isValidSaIdChecksum('8001015009087')).toBe(true);
    expect(isValidSaIdDigits('8001015009087')).toBe(true);
    expect(saIdValidationMessage('8001015009087')).toBeNull();
  });

  it('rejects checksum failures with a helpful message', () => {
    expect(isValidSaIdDigits('8001015009080')).toBe(false);
    expect(saIdValidationMessage('8001015009080')).toMatch(/checksum/);
    expect(saIdValidationMessage('8001015009080')).toMatch(/9080/);
  });

  it('scores plausible SA ID structure higher', () => {
    expect(scoreSaIdCandidate('8001015009087')).toBeGreaterThan(0);
    expect(scoreSaIdCandidate('8001015009080')).toBe(-1);
  });
});
