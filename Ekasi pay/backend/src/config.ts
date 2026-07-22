import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.join(__dirname, '..', '.env') });

export const PORT = Number(process.env.PORT ?? 8787);
export const NODE_ENV = process.env.NODE_ENV ?? 'development';
export const IS_LOCAL_ENV = NODE_ENV === 'development' || NODE_ENV === 'test';

const FALLBACK_DEV_JWT_SECRET = 'dev-only-change-me-ekasi-pay';

/**
 * JWT signing secret. In deployed environments a real value MUST be supplied — the
 * process refuses to start with the dev fallback. In non-production it falls
 * back so local dev "just works".
 */
export const JWT_SECRET = (() => {
  const raw = process.env.JWT_SECRET?.trim();
  if (!IS_LOCAL_ENV) {
    if (!raw || raw === FALLBACK_DEV_JWT_SECRET) {
      throw new Error(
        'JWT_SECRET is required outside development/test. Set a unique, high-entropy value (>= 32 chars).',
      );
    }
    if (raw.length < 32) {
      throw new Error(
        'JWT_SECRET must be at least 32 characters long outside development/test.',
      );
    }
    return raw;
  }
  return raw || FALLBACK_DEV_JWT_SECRET;
})();

export const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173';

function normalizeOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;

  let origin = trimmed;
  if (!/^https?:\/\//i.test(origin)) {
    origin = `https://${origin}`;
  }

  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();
    const isLocalHost =
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host.endsWith('.localhost');
    if (!host.includes('.') && !isLocalHost) {
      url.hostname = `${url.hostname}.onrender.com`;
      origin = url.origin;
    }
  } catch {
    /* keep best-effort origin */
  }

  return origin;
}

/** Explicit browser origins, with local defaults only in development/test. */
export function listFrontendOrigins(): string[] {
  const configured = [
    ...(process.env.FRONTEND_ORIGINS?.split(/[\s,]+/) ?? []),
    process.env.FRONTEND_ORIGIN ?? '',
    process.env.OPS_DASHBOARD_ORIGIN ?? '',
  ]
    .map((s) => normalizeOrigin(s))
    .filter(Boolean);
  const fromEnv =
    IS_LOCAL_ENV
      ? [...configured, 'http://localhost:5173', 'http://localhost:5174']
      : configured;

  // Deduplicate while preserving order.
  return [...new Set(fromEnv)];
}

/** Short-lived bearer JWT (seconds). */
function positiveNumber(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a finite positive number.`);
  }
  return value;
}

export const ACCESS_TOKEN_TTL_SEC = positiveNumber('ACCESS_TOKEN_TTL_SEC', 60 * 15);

/** Refresh session window (seconds). Each rotation pushes expires_at forward to now + this. */
export const REFRESH_TOKEN_TTL_SEC = positiveNumber(
  'REFRESH_TOKEN_TTL_SEC',
  7 * 24 * 60 * 60,
);

/**
 * Hard cap on a single session's lifetime (seconds). The "sliding" refresh
 * TTL keeps active users logged in, but `absolute_expires_at` ensures a session
 * has to be re-established with PIN entry at most every N days regardless of
 * rotation activity. Defaults to 30 days.
 */
export const REFRESH_ABSOLUTE_TTL_SEC = positiveNumber(
  'REFRESH_ABSOLUTE_TTL_SEC',
  30 * 24 * 60 * 60,
);

export const REFRESH_TOKEN_PEPPER =
  process.env.REFRESH_TOKEN_PEPPER?.trim() ||
  (IS_LOCAL_ENV ? 'dev-only-refresh-token-pepper' : '');

/** Independent pepper for hashing PIN-reset SMS codes. */
export const PIN_RESET_PEPPER = (() => {
  const raw = process.env.PIN_RESET_PEPPER?.trim();
  return raw || (IS_LOCAL_ENV ? 'dev-only-pin-reset-pepper' : '');
})();

/** @deprecated use ACCESS_TOKEN_TTL_SEC */
export const SESSION_TTL_SEC = ACCESS_TOKEN_TTL_SEC;

const defaultDb =
  path.join(__dirname, '..', 'data', 'ekasi-pay.db');

export const DATABASE_PATH =
  process.env.DATABASE_PATH ??
  path.resolve(defaultDb);

/** PostgreSQL is mandatory outside development/test; SQLite is local-only. */
export const DATABASE_URL = process.env.DATABASE_URL?.trim() ?? '';
export const IS_POSTGRES = DATABASE_URL.length > 0;

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return defaultValue;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new Error(`${name} must be a boolean (true/false).`);
}

/**
 * Phase 0 production controls. Financial and regulated products fail closed in
 * production, while development remains usable unless explicitly disabled.
 */
const riskyProductDefault = IS_LOCAL_ENV;
export const FINANCIAL_POSTING_ENABLED = envFlag(
  'FINANCIAL_POSTING_ENABLED',
  riskyProductDefault,
);
/** Working-capital loans (apply / disburse / repay). Off outside local by default. */
export const LENDING_ENABLED = envFlag(
  'LENDING_ENABLED',
  riskyProductDefault,
);
/** @deprecated use LENDING_ENABLED */
export const LENDING_DISBURSEMENT_ENABLED = envFlag(
  'LENDING_DISBURSEMENT_ENABLED',
  LENDING_ENABLED,
);
export const INSURANCE_ENABLED = envFlag(
  'INSURANCE_ENABLED',
  riskyProductDefault,
);
export const STOKVEL_MONEY_MOVEMENT_ENABLED = envFlag(
  'STOKVEL_MONEY_MOVEMENT_ENABLED',
  riskyProductDefault,
);
/** Real Cash Send create / collect / cancel. Off outside local by default. */
export const CASH_SEND_ENABLED = envFlag(
  'CASH_SEND_ENABLED',
  riskyProductDefault,
);
export const LIVE_UTILITIES_ENABLED = envFlag(
  'LIVE_UTILITIES_ENABLED',
  riskyProductDefault,
);

/** Max auth attempts per IP per minute (login, register, refresh). */
export const LOGIN_RATE_LIMIT_PER_MIN = positiveNumber(
  'LOGIN_RATE_LIMIT_PER_MIN',
  20,
);

/** SMS delivery: console (dev), twilio, or clickatell. */
export const SMS_PROVIDER = (() => {
  const raw = process.env.SMS_PROVIDER?.trim().toLowerCase();
  if (!raw) return IS_LOCAL_ENV ? 'console' : '';
  if (raw === 'console' || raw === 'twilio' || raw === 'clickatell') return raw;
  throw new Error('SMS_PROVIDER must be console, twilio, or clickatell.');
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
  if (!raw) return IS_LOCAL_ENV ? 'mock' : 'disabled';
  throw new Error('UTILITY_PROVIDER must be mock, http, or disabled.');
})();

export const UTILITY_VENDOR_WEBHOOK_URL =
  process.env.UTILITY_VENDOR_WEBHOOK_URL?.trim() ?? '';
export const UTILITY_VENDOR_API_KEY =
  process.env.UTILITY_VENDOR_API_KEY?.trim() ?? '';
export const PROVIDER_CALLBACK_SECRET =
  process.env.PROVIDER_CALLBACK_SECRET?.trim() ?? '';

export const UTILITY_MAX_AMOUNT =
  process.env.UTILITY_MAX_AMOUNT?.trim() || '500.00';

/** Load shedding feed source: db seed table (default) or remote HTTP feed. */
export const LOAD_SHEDDING_PROVIDER = (() => {
  const raw = process.env.LOAD_SHEDDING_PROVIDER?.trim().toLowerCase();
  if (raw === 'http' || raw === 'db') return raw;
  if (!raw) return 'db';
  throw new Error('LOAD_SHEDDING_PROVIDER must be http or db.');
})();

export const LOAD_SHEDDING_FEED_URL =
  process.env.LOAD_SHEDDING_FEED_URL?.trim() ?? '';

/** Shown in Cash Send voucher SMS when the creating shop has no merchant profile. */
export const CASH_SEND_COLLECT_HINT =
  process.env.CASH_SEND_COLLECT_HINT?.trim() ??
  'Withdraw at any KasiPay partner shop (Services > Collect cash).';

/** Explicit operational readiness markers required for deployed environments. */
export const MONITORING_PROVIDER =
  process.env.MONITORING_PROVIDER?.trim().toLowerCase() ?? '';
export const MONITORING_DSN = process.env.MONITORING_DSN?.trim() ?? '';

/**
 * Optional Redis URL for shared rate-limit counters across API instances.
 * When unset, express-rate-limit uses in-memory stores (single-instance only).
 */
export const RATE_LIMIT_REDIS_URL =
  process.env.RATE_LIMIT_REDIS_URL?.trim() ?? '';
export const BACKUP_PROVIDER =
  process.env.BACKUP_PROVIDER?.trim().toLowerCase() ?? '';
export const BACKUP_RETENTION_DAYS = positiveNumber(
  'BACKUP_RETENTION_DAYS',
  30,
);
