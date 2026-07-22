import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decryptField,
  encryptField,
  hashSensitiveIdentifier,
  hashesEqual,
  maskIdentifier,
} from './security/fieldEncryption.js';

test('encrypts and decrypts sensitive fields without plaintext round-trip loss', () => {
  const plain = '8001015009087';
  const encrypted = encryptField(plain);
  assert.notEqual(encrypted, plain);
  assert.equal(decryptField(encrypted), plain);
});

test('blind hashes match for the same normalized identifier', () => {
  const a = hashSensitiveIdentifier('8001015009087');
  const b = hashSensitiveIdentifier('8001015009087');
  assert.ok(hashesEqual(a, b));
  assert.equal(hashesEqual(a, hashSensitiveIdentifier('8001015009080')), false);
});

test('masks identifiers for operations surfaces', () => {
  assert.equal(maskIdentifier('8001015009087'), '80••••••••087');
});
