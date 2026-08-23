import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  generateMerchantFloatReference,
  parseMerchantFloatReference,
} from './floatReference.js';

describe('merchant float references', () => {
  it('is deterministic and checksummed', () => {
    const first = generateMerchantFloatReference('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    const second = generateMerchantFloatReference('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    assert.equal(first, second);
    assert.match(first, /^KP-FLOAT-[A-Z0-9]{8}-[A-F0-9]{4}$/);
    assert.deepEqual(parseMerchantFloatReference(first), {
      shortId: 'A1B2C3D4',
      checksum: first.slice(-4),
    });
  });

  it('rejects a tampered checksum', () => {
    const valid = generateMerchantFloatReference('merchant-1');
    assert.equal(parseMerchantFloatReference(valid.slice(0, -1) + '0'), null);
  });
});
