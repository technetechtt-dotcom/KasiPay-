import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertResourceScope,
  CAPABILITIES,
  ENDPOINT_CAPABILITIES,
  roleHasCapability,
} from './security/authorization.js';
import { generateTotpSecret, totpAt, verifyTotp } from './security/totp.js';
import { validateDocumentSignature } from './services/privateObjectStorage.js';

describe('Phase 4 deny-by-default authorization', () => {
  it('does not grant unknown or legacy broad roles any capability', () => {
    for (const role of ['operator', 'super_admin', 'admin_typo', '']) {
      for (const capability of CAPABILITIES) {
        assert.equal(roleHasCapability(role, capability), false);
      }
    }
  });

  it('blocks vertical escalation between operational roles', () => {
    assert.equal(roleHasCapability('support', 'operators:write'), false);
    assert.equal(roleHasCapability('operations', 'finance:approve'), false);
    assert.equal(roleHasCapability('finance', 'kyc:download'), false);
    assert.equal(roleHasCapability('compliance', 'operators:write'), false);
    assert.equal(roleHasCapability('admin', 'operators:write'), true);
  });

  it('maps every privileged endpoint to a known capability', () => {
    for (const capability of Object.values(ENDPOINT_CAPABILITIES)) {
      assert.ok(CAPABILITIES.includes(capability));
    }
  });

  it('denies horizontal access without ownership or explicit cross-tenant authority', () => {
    assert.equal(assertResourceScope('actor-a', 'actor-b'), false);
    assert.equal(assertResourceScope('actor-a', 'actor-a'), true);
    assert.equal(assertResourceScope('actor-a', 'actor-b', true), true);
  });
});

describe('Phase 4 authentication and KYC primitives', () => {
  it('accepts a current TOTP and rejects another code', () => {
    const secret = generateTotpSecret();
    const now = 1_750_000_000_000;
    const code = totpAt(secret, now);
    assert.equal(verifyTotp(secret, code, now), true);
    assert.equal(verifyTotp(secret, code === '000000' ? '000001' : '000000', now), false);
  });

  it('validates MIME signatures instead of trusting file extensions', () => {
    const pdf = Buffer.from('%PDF-1.7').toString('base64');
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64');
    assert.equal(validateDocumentSignature('application/pdf', pdf), true);
    assert.equal(validateDocumentSignature('image/png', png), true);
    assert.equal(validateDocumentSignature('image/jpeg', pdf), false);
  });
});
