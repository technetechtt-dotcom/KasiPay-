import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearSenderKycProfile,
  loadSenderKycProfile,
  saveSenderKycProfile,
} from './senderKycProfile';

describe('senderKycProfile', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('returns null when nothing is stored', () => {
    expect(loadSenderKycProfile('0820000000')).toBeNull();
  });

  it('persists and reloads a profile scoped to the phone number', () => {
    const profile = {
      phone: '0820000000',
      firstName: 'Lebo',
      lastName: 'Khumalo',
      idDocument: '8001015009087',
      address: '12 Long St, Soweto',
      savedAt: new Date('2026-01-15T10:00:00Z').toISOString(),
    };
    saveSenderKycProfile(profile);
    expect(loadSenderKycProfile('0820000000')).toEqual(profile);
    // Different user on shared device: should not reuse the cache.
    expect(loadSenderKycProfile('0833333333')).toBeNull();
  });

  it('clears the cache on logout', () => {
    saveSenderKycProfile({
      phone: '0820000000',
      firstName: 'a',
      lastName: 'b',
      idDocument: '8001015009087',
      address: 'x',
      savedAt: new Date().toISOString(),
    });
    clearSenderKycProfile();
    expect(loadSenderKycProfile('0820000000')).toBeNull();
  });

  it('ignores malformed JSON', () => {
    window.localStorage.setItem('kasiPay.senderKyc.v1', '{not json');
    expect(loadSenderKycProfile('0820000000')).toBeNull();
  });
});
