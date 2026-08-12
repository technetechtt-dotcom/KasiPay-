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

function isRenderRuntime(env: NodeJS.ProcessEnv): boolean {
  return env.RENDER === 'true' || Boolean(env.RENDER_SERVICE_NAME?.trim());
}

function anyMoneyFlagEnabled(env: NodeJS.ProcessEnv): boolean {
  return (
    envFlagEnabled(env, 'REGULATED_PRODUCTS_PRODUCTION_ENABLED') ||
    envFlagEnabled(env, 'LENDING_DISBURSEMENT_ENABLED') ||
    EXPLICIT_OFF_FLAGS.some((name) => envFlagEnabled(env, name))
  );
}

/**
 * Non-funds boot skips live vendor secrets.
 * Render sets RENDER=true; blueprint flags often never sync onto an existing
 * service, so unset money flags on Render count as off.
 */
export function isNonFundsDeployment(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (anyMoneyFlagEnabled(env)) return false;
  if (envFlagEnabled(env, 'NON_FUNDS_PRODUCTION')) return true;
  if (isRenderRuntime(env)) return true;
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
