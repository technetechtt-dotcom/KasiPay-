import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.join(__dirname, '..', '.env') });

export const OPS_PORT = Number(process.env.OPS_PORT ?? 8790);
export const NODE_ENV = process.env.NODE_ENV ?? 'development';

const FALLBACK_JWT = 'dev-only-ops-dashboard-jwt-secret';

export const OPS_JWT_SECRET = (() => {
  const raw = process.env.OPS_JWT_SECRET?.trim();
  if (NODE_ENV === 'production') {
    if (!raw || raw === FALLBACK_JWT || raw.length < 32) {
      throw new Error(
        'OPS_JWT_SECRET must be set to a unique value of at least 32 characters in production.',
      );
    }
    return raw;
  }
  return raw || FALLBACK_JWT;
})();

export const OPS_DASHBOARD_PASSWORD =
  process.env.OPS_DASHBOARD_PASSWORD?.trim() ?? '';

function normalizeOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || /^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export const OPS_DASHBOARD_ORIGIN = normalizeOrigin(
  process.env.OPS_DASHBOARD_ORIGIN ?? 'http://localhost:5174',
);

export const OPS_TOKEN_TTL_SEC = Number(
  process.env.OPS_TOKEN_TTL_SEC ?? 8 * 60 * 60,
);

export const DATABASE_URL = process.env.DATABASE_URL?.trim() ?? '';
export const IS_POSTGRES = DATABASE_URL.length > 0;

const defaultSqlite = path.resolve(
  __dirname,
  '..',
  '..',
  'backend',
  'data',
  'ekasi-pay.db',
);

export const DATABASE_PATH = path.resolve(
  process.env.DATABASE_PATH ?? defaultSqlite,
);

export function validateOpsConfig(): void {
  if (NODE_ENV !== 'production') return;
  if (!OPS_DASHBOARD_PASSWORD) {
    throw new Error('OPS_DASHBOARD_PASSWORD is required in production.');
  }
  if (!IS_POSTGRES && !DATABASE_PATH) {
    throw new Error(
      'Production ops dashboard requires DATABASE_URL (Postgres) or DATABASE_PATH.',
    );
  }
}
