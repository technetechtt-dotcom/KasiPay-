/**
 * Pilot support contacts come from build-time env (Render / Vite) or
 * `window.__KASIPAY_SUPPORT__` written by `scripts/write-runtime-config.mjs`.
 * Missing values must not fall back to fake placeholder numbers.
 */
export type SupportContacts = {
  whatsappE164: string;
  phoneTel: string;
  phoneDisplay: string;
  email: string;
};

type RuntimeSupport = {
  whatsapp?: string;
  phone?: string;
  phoneDisplay?: string;
  email?: string;
};

function trimEnv(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readRuntimeSupport(): RuntimeSupport {
  if (typeof window === 'undefined') return {};
  const raw = window.__KASIPAY_SUPPORT__;
  return raw && typeof raw === 'object' ? raw : {};
}

export function readSupportContacts(
  env: Record<string, string | undefined> = import.meta.env as Record<
    string,
    string | undefined
  >,
): SupportContacts {
  const runtime = readRuntimeSupport();
  const whatsappE164 = (
    trimEnv(env.VITE_SUPPORT_WHATSAPP) || trimEnv(runtime.whatsapp)
  ).replace(/[^\d]/g, '');
  const phoneTel = (
    trimEnv(env.VITE_SUPPORT_PHONE) || trimEnv(runtime.phone)
  ).replace(/[^\d+]/g, '');
  const phoneDisplay =
    trimEnv(env.VITE_SUPPORT_PHONE_DISPLAY) ||
    trimEnv(runtime.phoneDisplay) ||
    (phoneTel ? phoneTel.replace(/^\+?27/, '0') : '');
  const email = trimEnv(env.VITE_SUPPORT_EMAIL) || trimEnv(runtime.email);

  return { whatsappE164, phoneTel, phoneDisplay, email };
}

export function supportConfigured(contacts: SupportContacts): boolean {
  return Boolean(contacts.whatsappE164 || contacts.phoneTel || contacts.email);
}
