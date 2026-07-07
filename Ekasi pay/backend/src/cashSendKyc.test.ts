import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  cashSendIdsMatch,
  generateCashSendReference,
  isValidSaIdChecksum,
  normalizeCashSendId,
  parseCashSendVoucherReference,
  validateSaIdDigits,
} from './cashSendKyc.js';

describe('isValidSaIdChecksum', () => {
  it('accepts a known-valid SA ID', () => {
    assert.equal(isValidSaIdChecksum('8001015009087'), true);
    assert.equal(validateSaIdDigits('8001015009087'), true);
  });

  it('rejects IDs with an invalid checksum digit', () => {
    assert.equal(isValidSaIdChecksum('8001015009080'), false);
    assert.equal(validateSaIdDigits('8001015009080'), false);
  });

  it('rejects IDs that are not 13 digits', () => {
    assert.equal(validateSaIdDigits('123'), false);
    assert.equal(validateSaIdDigits('80010150090871'), false);
  });
});

describe('cashSendIdsMatch', () => {
  it('matches normalized ID strings', () => {
    assert.equal(
      cashSendIdsMatch('8001 0150 0908 7', '8001015009087'),
      true,
    );
    assert.equal(
      cashSendIdsMatch('8001015009087', '8001015009080'),
      false,
    );
  });

  it('normalizes non-digit characters away', () => {
    assert.equal(normalizeCashSendId('80-010-15009087'), '8001015009087');
  });
});

describe('parseCashSendVoucherReference', () => {
  it('accepts CS voucher numbers only', () => {
    assert.equal(
      parseCashSendVoucherReference(' cs1783348762065946 '),
      'CS1783348762065946',
    );
  });

  it('rejects cellphones and internal ids', () => {
    assert.equal(parseCashSendVoucherReference('0697040585'), null);
    assert.equal(
      parseCashSendVoucherReference('b42c6aaa-bd92-421a-971e-939b72de8394'),
      null,
    );
    assert.equal(parseCashSendVoucherReference('ABC123'), null);
  });
});

describe('generateCashSendReference', () => {
  it('returns CS prefix with 14 hex chars', () => {
    const ref = generateCashSendReference();
    assert.match(ref, /^CS[0-9A-F]{14}$/);
    assert.notEqual(ref, generateCashSendReference());
  });
});
