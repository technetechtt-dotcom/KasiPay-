import { createHmac } from 'node:crypto';

const EXPLICIT_OFF_FLAGS = [
  'FINANCIAL_POSTING_ENABLED',
  'CASH_SEND_ENABLED',
  'LENDING_ENABLED',
  'INSURANCE_ENABLED',
  'STOKVEL_MONEY_MOVEMENT_ENABLED',
  'LIVE_UTILITIES_ENABLED',
] as const;

export function envFlagEnabled(
  env: NodeJS.ProcessEnv,
  name: string,
): boolean {
  return /^(1|true|yes|on)$/iu.test(env[name]?.trim() ?? '');
}

function envFlagExplicitlyFalse(
  env: NodeJS.ProcessEnv,
  name: string,
): boolean {
  const raw = env[name]?.trim().toLowerCase() ?? '';
  return ['0', 'false', 'no', 'off'].includes(raw);
}

/**
 * Non-funds Render/pilot boot: every custodial money flag is explicitly false.
 * Unset flags keep full production validation (fail closed).
 */
export function isNonFundsDeployment(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (envFlagEnabled(env, 'REGULATED_PRODUCTS_PRODUCTION_ENABLED')) return false;
  if (envFlagEnabled(env, 'LENDING_DISBURSEMENT_ENABLED')) return false;
  if (envFlagEnabled(env, 'NON_FUNDS_PRODUCTION')) return true;
  return EXPLICIT_OFF_FLAGS.every((name) => envFlagExplicitlyFalse(env, name));
}

export function derivedDeploymentSecret(
  purpose: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const jwt = env.JWT_SECRET?.trim() ?? '';
  if (jwt.length < 32) {
    throw new Error(
      'JWT_SECRET is required to derive non-funds deployment secrets.',
    );
  }
  return createHmac('sha256', jwt)
    .update(`kasipay-nonfunds:${purpose}`)
    .digest('hex');
}

export function secretOrDerived(
  env: NodeJS.ProcessEnv,
  name: string,
  purpose: string,
  minimumLength = 32,
): string {
  const raw = env[name]?.trim() ?? '';
  if (raw.length >= minimumLength) return raw;
  if (isNonFundsDeployment(env)) return derivedDeploymentSecret(purpose, env);
  return raw;
}
