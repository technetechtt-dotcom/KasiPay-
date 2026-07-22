import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import test from 'node:test';

import {
  decryptField,
  encryptField,
  encryptionKeyVersionOf,
  hashSensitiveIdentifier,
  hashesEqual,
  maskIdentifier,
  rotateFieldToActiveKey,
} from './security/fieldEncryption.js';

test('encrypts and decrypts sensitive fields without plaintext round-trip loss', () => {
  const plain = '8001015009087';
  const encrypted = encryptField(plain);
  assert.notEqual(encrypted, plain);
  assert.match(encrypted, /^v\d+\./);
  assert.equal(decryptField(encrypted), plain);
  assert.equal(encryptionKeyVersionOf(encrypted), 1);
});

test('decrypts legacy unversioned ciphertext with the active key', () => {
  const plain = 'rotate-me-please';
  const key = Buffer.from(
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    'hex',
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const legacy = `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
  assert.equal(decryptField(legacy), plain);
  assert.equal(encryptionKeyVersionOf(legacy), 1);
  const rotated = rotateFieldToActiveKey(legacy);
  assert.match(rotated, /^v1\./);
  assert.equal(decryptField(rotated), plain);
});

test('blind hashes match for the same normalized identifier', () => {
  const a = hashSensitiveIdentifier('8001015009087');
  const b = hashSensitiveIdentifier('8001015009087');
  assert.match(a, /^v1:[a-f0-9]{64}$/i);
  assert.ok(hashesEqual(a, b));
  assert.equal(hashesEqual(a, hashSensitiveIdentifier('8001015009080')), false);
});

test('masks identifiers for operations surfaces', () => {
  assert.equal(maskIdentifier('8001015009087'), '80••••••••087');
});
