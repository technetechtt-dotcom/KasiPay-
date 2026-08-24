import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  generateMerchantFloatReference,
  parseMerchantFloatReference,
} from './floatReference.js';

describe('merchant float references', () => {
  it('is unique per request and checksummed', () => {
    const merchantId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const first = generateMerchantFloatReference(merchantId);
    const second = generateMerchantFloatReference(merchantId);
    assert.notEqual(first, second);
    assert.match(first, /^KP-FLOAT-[A-Z0-9]{8}-[A-Z0-9]{8}-[A-F0-9]{4}$/);
    const parsed = parseMerchantFloatReference(first);
    assert.equal(parsed?.shortId, 'A1B2C3D4');
    assert.equal(parsed?.checksum, first.slice(-4));
  });

  it('issues distinct references for consecutive top-ups by the same merchant', () => {
    const merchantId = 'merchant-repeat';
    const refs = new Set(
      Array.from({ length: 8 }, () => generateMerchantFloatReference(merchantId)),
    );
    assert.equal(refs.size, 8);
  });

  it('rejects a tampered checksum', () => {
    const valid = generateMerchantFloatReference('merchant-1');
    assert.equal(parseMerchantFloatReference(valid.slice(0, -1) + '0'), null);
  });

  it('still accepts a legacy deterministic reference', () => {
    const shortId = 'MERCHANT';
    const checksum = createHash('sha256')
      .update(`KP-FLOAT:${shortId}`)
      .digest('hex')
      .slice(0, 4)
      .toUpperCase();
    const legacy = `KP-FLOAT-${shortId}-${checksum}`;
    assert.deepEqual(parseMerchantFloatReference(legacy), {
      shortId,
      checksum,
    });
  });
});
