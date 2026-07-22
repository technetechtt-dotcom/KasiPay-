import assert from 'node:assert/strict';
import test from 'node:test';

import { collectProductionConfigErrors } from './validateProductionConfig.js';

const deployedEnv: NodeJS.ProcessEnv = {
  NODE_ENV: 'staging',
  DATABASE_URL: 'postgresql://user:pass@db.example.com/ekasi',
  FRONTEND_ORIGINS: 'https://app.example.com,https://ops.example.com',
  JWT_SECRET: 'j'.repeat(32),
  OPS_JWT_SECRET: 'o'.repeat(32),
  REFRESH_TOKEN_PEPPER: 'r'.repeat(32),
  PIN_RESET_PEPPER: 'p'.repeat(32),
  OPS_REFRESH_TOKEN_PEPPER: 'q'.repeat(32),
  PRIVATE_STORAGE_SIGNING_SECRET: 's'.repeat(32),
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  PII_HASH_PEPPER: Buffer.alloc(32, 9).toString('base64'),
  PII_HASH_PEPPER_VERSION: '1',
  PRIVATE_STORAGE_PROVIDER: 'external',
  PRIVATE_STORAGE_SIGNING_ENDPOINT: 'https://storage.example.com/sign',
  PRIVATE_STORAGE_ENCRYPTION_KEY_REF: 'kms-key-1',
  MALWARE_SCANNER_PROVIDER: 'external',
  MALWARE_SCANNER_CALLBACK_SECRET: 'm'.repeat(32),
  SMS_PROVIDER: 'twilio',
  TWILIO_ACCOUNT_SID: 'sid',
  TWILIO_AUTH_TOKEN: 'token',
  TWILIO_FROM_NUMBER: '+27110000000',
  UTILITY_PROVIDER: 'disabled',
  LOAD_SHEDDING_PROVIDER: 'db',
  MONITORING_PROVIDER: 'sentry',
  MONITORING_DSN: 'https://public@sentry.example.com/1',
  ALERT_ROUTING_MARKER: 'configured-in-monitoring-provider',
  RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379/0',
  SANCTIONS_PEP_PROVIDER: 'external',
  SANCTIONS_PEP_ENDPOINT: 'https://screening.example.com/v1/check',
  SANCTIONS_PEP_API_KEY: 'screening-key',
  AUDIT_SINK_PROVIDER: 'external',
  AUDIT_SINK_ENDPOINT: 'https://audit.example.com/v1/events',
  AUDIT_SINK_API_KEY: 'audit-key',
  BACKUP_PROVIDER: 'neon',
  BACKUP_RETENTION_DAYS: '30',
  BACKUP_MAX_AGE_HOURS: '26',
  RTO_MINUTES: '120',
  RPO_MINUTES: '60',
  BACKUP_ENCRYPTION_MARKER: 'provider-confirmed',
  BACKUP_PITR_MARKER: 'provider-confirmed',
  BACKUP_VERIFICATION_MARKER: 'restore-drill-required',
};

test('accepts a complete staging-like configuration', () => {
  assert.deepEqual(collectProductionConfigErrors(deployedEnv), []);
});

test('requires PostgreSQL and explicit HTTPS origins outside local environments', () => {
  const errors = collectProductionConfigErrors({
    ...deployedEnv,
    DATABASE_URL: '',
    FRONTEND_ORIGINS: 'http://localhost:5173',
  });
  assert(errors.some((error) => error.includes('DATABASE_URL')));
  assert(errors.some((error) => error.includes('HTTPS')));
});

test('requires independent deployed secrets and provider credentials', () => {
  const shared = 's'.repeat(32);
  const errors = collectProductionConfigErrors({
    ...deployedEnv,
    JWT_SECRET: shared,
    OPS_JWT_SECRET: shared,
    REFRESH_TOKEN_PEPPER: shared,
    PIN_RESET_PEPPER: shared,
    TWILIO_AUTH_TOKEN: '',
  });
  assert(errors.some((error) => error.includes('must be distinct')));
  assert(errors.some((error) => error.includes('TWILIO_AUTH_TOKEN')));
});

test('requires a dedicated PII hash pepper distinct from encryption key', () => {
  const missing = collectProductionConfigErrors({
    ...deployedEnv,
    PII_HASH_PEPPER: '',
  });
  assert(missing.some((error) => error.includes('PII_HASH_PEPPER')));
  const reused = collectProductionConfigErrors({
    ...deployedEnv,
    PII_HASH_PEPPER: deployedEnv.DATA_ENCRYPTION_KEY,
  });
  assert(reused.some((error) => error.includes('must be distinct') || error.includes('must differ')));
});

test('local development does not require deployed markers', () => {
  assert.deepEqual(collectProductionConfigErrors({ NODE_ENV: 'development' }), []);
  assert.deepEqual(collectProductionConfigErrors({ NODE_ENV: 'test' }), []);
});

test('regulated product config is fail-closed and forbids deployed sandbox', () => {
  const errors = collectProductionConfigErrors({
    ...deployedEnv,
    PHASE7_SANDBOX_ENABLED: 'true',
    PRODUCT_LENDING_PRODUCTION_ENABLED: 'true',
  });
  assert(errors.some((error) => error.includes('PHASE7_SANDBOX_ENABLED')));
  assert(
    errors.some((error) =>
      error.includes('PRODUCT_LENDING_PRODUCTION_ENABLED requires'),
    ),
  );
});

test('production utilities require a real provider mode', () => {
  const errors = collectProductionConfigErrors({
    ...deployedEnv,
    REGULATED_PRODUCTS_PRODUCTION_ENABLED: 'true',
    PRODUCT_UTILITIES_PRODUCTION_ENABLED: 'true',
    UTILITY_PROVIDER: 'disabled',
  });
  assert(errors.some((error) => error.includes('requires UTILITY_PROVIDER=http')));
});
