/**
 * Pilot support contacts come from build-time env (Render / Vite).
 * Missing values must not fall back to fake placeholder numbers.
 */
export type SupportContacts = {
  whatsappE164: string;
  phoneTel: string;
  phoneDisplay: string;
  email: string;
};

function trimEnv(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function readSupportContacts(
  env: Record<string, string | undefined> = import.meta.env as Record<
    string,
    string | undefined
  >,
): SupportContacts {
  const whatsappE164 = trimEnv(env.VITE_SUPPORT_WHATSAPP).replace(/[^\d]/g, '');
  const phoneTel = trimEnv(env.VITE_SUPPORT_PHONE).replace(/[^\d+]/g, '');
  const phoneDisplay =
    trimEnv(env.VITE_SUPPORT_PHONE_DISPLAY) ||
    (phoneTel ? phoneTel.replace(/^\+?27/, '0') : '');
  const email = trimEnv(env.VITE_SUPPORT_EMAIL);

  return { whatsappE164, phoneTel, phoneDisplay, email };
}

export function supportConfigured(contacts: SupportContacts): boolean {
  return Boolean(contacts.whatsappE164 || contacts.phoneTel || contacts.email);
}
