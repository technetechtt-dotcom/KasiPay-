import {
  listFrontendOrigins,
  NODE_ENV,
  SMS_PROVIDER,
  UTILITY_PROVIDER,
  UTILITY_VENDOR_WEBHOOK_URL,
} from './config.js';

/**
 * Refuse to boot in production when critical env is missing or unsafe.
 * Development skips these checks so local pilots work out of the box.
 */
export function validateProductionConfig(): void {
  if (NODE_ENV !== 'production') return;

  const origins = listFrontendOrigins();
  const onlyLocal = origins.every(
    (o) =>
      o.includes('localhost') ||
      o.includes('127.0.0.1') ||
      o === 'capacitor://localhost',
  );
  if (onlyLocal) {
    throw new Error(
      'Production requires FRONTEND_ORIGINS (or FRONTEND_ORIGIN) with your deployed app origin(s).',
    );
  }

  if (SMS_PROVIDER === 'console' || !SMS_PROVIDER) {
    throw new Error(
      'Production requires SMS_PROVIDER=twilio or clickatell with provider credentials.',
    );
  }

  if (UTILITY_PROVIDER === 'mock') {
    throw new Error(
      'Production cannot use UTILITY_PROVIDER=mock. Set http (with UTILITY_VENDOR_WEBHOOK_URL) or disabled.',
    );
  }

  if (UTILITY_PROVIDER === 'http' && !UTILITY_VENDOR_WEBHOOK_URL) {
    throw new Error(
      'Production requires UTILITY_VENDOR_WEBHOOK_URL when UTILITY_PROVIDER=http.',
    );
  }
}
