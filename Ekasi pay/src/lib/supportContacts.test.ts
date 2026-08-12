import { afterEach, describe, expect, it } from 'vitest';

import { readSupportContacts, supportConfigured } from './supportContacts';

afterEach(() => {
  delete window.__KASIPAY_SUPPORT__;
});

describe('supportContacts', () => {
  it('does not invent placeholder numbers when unset', () => {
    const contacts = readSupportContacts({});
    expect(contacts).toEqual({
      whatsappE164: '',
      phoneTel: '',
      phoneDisplay: '',
      email: '',
    });
    expect(supportConfigured(contacts)).toBe(false);
  });

  it('normalizes configured WhatsApp and phone values', () => {
    const contacts = readSupportContacts({
      VITE_SUPPORT_WHATSAPP: '+27 80 012 3456',
      VITE_SUPPORT_PHONE: '+27800123456',
      VITE_SUPPORT_PHONE_DISPLAY: '0800 123 456',
      VITE_SUPPORT_EMAIL: 'support@example.com',
    });
    expect(contacts.whatsappE164).toBe('27800123456');
    expect(contacts.phoneTel).toBe('+27800123456');
    expect(contacts.phoneDisplay).toBe('0800 123 456');
    expect(contacts.email).toBe('support@example.com');
    expect(supportConfigured(contacts)).toBe(true);
  });

  it('uses runtime-config support when Vite env is empty', () => {
    window.__KASIPAY_SUPPORT__ = { email: 'ivanjohnsonijj@gmail.com' };
    const contacts = readSupportContacts({});
    expect(contacts.email).toBe('ivanjohnsonijj@gmail.com');
    expect(supportConfigured(contacts)).toBe(true);
  });

  it('treats email-only as configured (no fake phone required)', () => {
    const contacts = readSupportContacts({
      VITE_SUPPORT_EMAIL: 'ivanjohnsonijj@gmail.com',
    });
    expect(contacts.whatsappE164).toBe('');
    expect(contacts.phoneTel).toBe('');
    expect(supportConfigured(contacts)).toBe(true);
  });
});
