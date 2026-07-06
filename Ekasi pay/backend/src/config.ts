import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.join(__dirname, '..', '.env') });

export const PORT = Number(process.env.PORT ?? 8787);
export const NODE_ENV = process.env.NODE_ENV ?? 'development';

const FALLBACK_DEV_JWT_SECRET = 'dev-only-change-me-ekasi-pay';

/**
 * JWT signing secret. In production a real value MUST be supplied — the
 * process refuses to start with the dev fallback. In non-production it falls
 * back so local dev "just works".
 */
export const JWT_SECRET = (() => {
  const raw = process.env.JWT_SECRET?.trim();
  if (NODE_ENV === 'production') {
    if (!raw || raw === FALLBACK_DEV_JWT_SECRET) {
      throw new Error(
        'JWT_SECRET is required in production. Set a unique, high-entropy value (>= 32 chars).',
      );
    }
    if (raw.length < 32) {
      throw new Error(
        'JWT_SECRET must be at least 32 characters long in production.',
      );
    }
    return raw;
  }
  return raw || FALLBACK_DEV_JWT_SECRET;
})();

export const FRONTEND_ORIGIN =
  process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173';

function normalizeOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || /^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/** Comma-separated origins (prod CORS). Falls back to FRONTEND_ORIGIN. */
export function listFrontendOrigins(): string[] {
  const multi = process.env.FRONTEND_ORIGINS?.split(/[\s,]+/)
    .map((s) => normalizeOrigin(s))
    .filter(Boolean);
  if (multi && multi.length > 0) return multi;
  return [normalizeOrigin(FRONTEND_ORIGIN)];
}

/** Short-lived bearer JWT (seconds). */
export const ACCESS_TOKEN_TTL_SEC = Number(
  process.env.ACCESS_TOKEN_TTL_SEC ?? 60 * 15
);

/** Refresh session window (seconds). Each rotation pushes expires_at forward to now + this. */
export const REFRESH_TOKEN_TTL_SEC = Number(
  process.env.REFRESH_TOKEN_TTL_SEC ?? 7 * 24 * 60 * 60
);

/**
 * Hard cap on a single session's lifetime (seconds). The "sliding" refresh
 * TTL keeps active users logged in, but `absolute_expires_at` ensures a session
 * has to be re-established with PIN entry at most every N days regardless of
 * rotation activity. Defaults to 30 days.
 */
export const REFRESH_ABSOLUTE_TTL_SEC = Number(
  process.env.REFRESH_ABSOLUTE_TTL_SEC ?? 30 * 24 * 60 * 60
);

export const REFRESH_TOKEN_PEPPER =
  process.env.REFRESH_TOKEN_PEPPER ?? JWT_SECRET;

/** @deprecated use ACCESS_TOKEN_TTL_SEC */
export const SESSION_TTL_SEC = ACCESS_TOKEN_TTL_SEC;

const defaultDb =
  path.join(__dirname, '..', 'data', 'ekasi-pay.db');

export const DATABASE_PATH =
  process.env.DATABASE_PATH ??
  path.resolve(defaultDb);

/** When set, backend boots in Postgres mode (Phase 1 dual-mode rollout). */
export const DATABASE_URL = process.env.DATABASE_URL?.trim() ?? '';
export const IS_POSTGRES = DATABASE_URL.length > 0;

/** Max auth attempts per IP per minute (login, register, refresh). */
export const LOGIN_RATE_LIMIT_PER_MIN = Number(
  process.env.LOGIN_RATE_LIMIT_PER_MIN ?? 20
);

/** SMS delivery: console (dev), twilio, or clickatell. */
export const SMS_PROVIDER = (() => {
  const raw = process.env.SMS_PROVIDER?.trim().toLowerCase();
  if (raw) return raw;
  return NODE_ENV === 'production' ? '' : 'console';
})();

export const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID?.trim() ?? '';
export const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN?.trim() ?? '';
export const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER?.trim() ?? '';
export const CLICKATELL_API_KEY = process.env.CLICKATELL_API_KEY?.trim() ?? '';

/**
 * Utility vendor integration: mock (dev only), http (webhook to real vendor), or disabled.
 */
export const UTILITY_PROVIDER = (() => {
  const raw = process.env.UTILITY_PROVIDER?.trim().toLowerCase();
  if (raw === 'mock' || raw === 'http' || raw === 'disabled') return raw;
  return NODE_ENV === 'production' ? 'disabled' : 'mock';
})();

export const UTILITY_VENDOR_WEBHOOK_URL =
  process.env.UTILITY_VENDOR_WEBHOOK_URL?.trim() ?? '';
export const UTILITY_VENDOR_API_KEY =
  process.env.UTILITY_VENDOR_API_KEY?.trim() ?? '';

export const UTILITY_MAX_AMOUNT = Number(process.env.UTILITY_MAX_AMOUNT ?? 500);

/** Load shedding feed source: db seed table (default) or remote HTTP feed. */
export const LOAD_SHEDDING_PROVIDER = (() => {
  const raw = process.env.LOAD_SHEDDING_PROVIDER?.trim().toLowerCase();
  if (raw === 'http' || raw === 'db') return raw;
  return 'db';
})();

export const LOAD_SHEDDING_FEED_URL =
  process.env.LOAD_SHEDDING_FEED_URL?.trim() ?? '';

/** Shown in Cash Send voucher SMS when the creating shop has no merchant profile. */
export const CASH_SEND_COLLECT_HINT =
  process.env.CASH_SEND_COLLECT_HINT?.trim() ??
  'Withdraw at any KasiPay partner shop (Services > Collect cash).';
