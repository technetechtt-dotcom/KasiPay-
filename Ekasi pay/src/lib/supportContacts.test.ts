import { describe, expect, it } from 'vitest';

import { readSupportContacts, supportConfigured } from './supportContacts';

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
});
