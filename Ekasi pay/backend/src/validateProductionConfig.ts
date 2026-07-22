/**
 * Return every deployed-environment configuration error without reading a DB.
 * Keeping this pure makes staging/production policy testable in CI.
 */
export function collectProductionConfigErrors(
  env: NodeJS.ProcessEnv,
): string[] {
  const nodeEnv = env.NODE_ENV?.trim() || 'development';
  if (nodeEnv === 'development' || nodeEnv === 'test') return [];

  const errors: string[] = [];
  const required = (name: string, minimumLength = 1): string => {
    const value = env[name]?.trim() ?? '';
    if (value.length < minimumLength) {
      errors.push(
        minimumLength > 1
          ? `${name} must be at least ${minimumLength} characters.`
          : `${name} is required.`,
      );
    }
    return value;
  };
  const positive = (name: string, fallback?: number): void => {
    const raw = env[name] ?? (fallback === undefined ? '' : String(fallback));
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      errors.push(`${name} must be a finite positive number.`);
    }
  };
  const httpsUrl = (name: string, value: string): void => {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || !url.hostname) {
        errors.push(`${name} must contain HTTPS URL(s).`);
      }
    } catch {
      errors.push(`${name} must contain valid HTTPS URL(s).`);
    }
  };

  const databaseUrl = required('DATABASE_URL');
  try {
    const parsed = new URL(databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
      errors.push('DATABASE_URL must be a PostgreSQL connection string.');
    }
  } catch {
    if (databaseUrl) errors.push('DATABASE_URL must be a valid URL.');
  }

  const origins = [
    ...(env.FRONTEND_ORIGINS?.split(/[\s,]+/) ?? []),
    env.FRONTEND_ORIGIN ?? '',
    env.OPS_DASHBOARD_ORIGIN ?? '',
  ].filter((value) => value.trim().length > 0);
  if (origins.length === 0) {
    errors.push('At least one explicit frontend origin is required.');
  } else {
    for (const origin of origins) httpsUrl('Frontend origin', origin);
  }

  const jwtSecret = required('JWT_SECRET', 32);
  const refreshPepper = required('REFRESH_TOKEN_PEPPER', 32);
  const pinResetPepper = required('PIN_RESET_PEPPER', 32);
  const opsJwtSecret = required('OPS_JWT_SECRET', 32);
  const opsRefreshPepper = required('OPS_REFRESH_TOKEN_PEPPER', 32);
  const storageSigningSecret = required('PRIVATE_STORAGE_SIGNING_SECRET', 32);
  const dataEncryptionKey = required('DATA_ENCRYPTION_KEY', 43);
  const secrets = [
    jwtSecret, refreshPepper, pinResetPepper, opsJwtSecret,
    opsRefreshPepper, storageSigningSecret,
  ].filter(Boolean);
  if (new Set(secrets).size !== secrets.length) {
    errors.push(
      'JWT, refresh, recovery, operator, and storage signing secrets must be distinct.',
    );
  }

  for (const [name, fallback] of [
    ['ACCESS_TOKEN_TTL_SEC', 900],
    ['REFRESH_TOKEN_TTL_SEC', 604800],
    ['REFRESH_ABSOLUTE_TTL_SEC', 2592000],
    ['LOGIN_RATE_LIMIT_PER_MIN', 20],
    ['UTILITY_MAX_AMOUNT', 500],
    ['OPS_TOKEN_TTL_SEC', 600],
    ['BACKUP_RETENTION_DAYS', 30],
    ['BACKUP_MAX_AGE_HOURS', 26],
    ['RTO_MINUTES', 120],
    ['RPO_MINUTES', 60],
  ] as const) {
    positive(name, fallback);
  }

  const smsProvider = required('SMS_PROVIDER').toLowerCase();
  if (!['twilio', 'clickatell'].includes(smsProvider)) {
    errors.push('SMS_PROVIDER must be twilio or clickatell.');
  } else if (smsProvider === 'twilio') {
    required('TWILIO_ACCOUNT_SID');
    required('TWILIO_AUTH_TOKEN');
    required('TWILIO_FROM_NUMBER');
  } else {
    required('CLICKATELL_API_KEY');
  }

  const utilityProvider = (env.UTILITY_PROVIDER?.trim() || 'disabled').toLowerCase();
  if (!['http', 'disabled'].includes(utilityProvider)) {
    errors.push('UTILITY_PROVIDER must be http or disabled.');
  }
  if (utilityProvider === 'http') {
    const webhook = required('UTILITY_VENDOR_WEBHOOK_URL');
    if (webhook) httpsUrl('UTILITY_VENDOR_WEBHOOK_URL', webhook);
    required('UTILITY_VENDOR_API_KEY');
    required('PROVIDER_CALLBACK_SECRET', 32);
  }
  const enabledFlag = (name: string) =>
    /^(1|true|yes|on)$/iu.test(env[name]?.trim() ?? '');
  if (enabledFlag('PHASE7_SANDBOX_ENABLED')) {
    errors.push('PHASE7_SANDBOX_ENABLED must be false outside development/test.');
  }
  const regulatedGlobal = enabledFlag('REGULATED_PRODUCTS_PRODUCTION_ENABLED');
  const productFlags = [
    'PRODUCT_STOKVEL_PRODUCTION_ENABLED',
    'PRODUCT_LENDING_PRODUCTION_ENABLED',
    'PRODUCT_MERCHANT_CREDIT_PRODUCTION_ENABLED',
    'PRODUCT_INSURANCE_PRODUCTION_ENABLED',
    'PRODUCT_UTILITIES_PRODUCTION_ENABLED',
  ];
  for (const name of productFlags) {
    if (enabledFlag(name) && !regulatedGlobal) {
      errors.push(`${name} requires REGULATED_PRODUCTS_PRODUCTION_ENABLED=true.`);
    }
  }
  if (enabledFlag('PRODUCT_UTILITIES_PRODUCTION_ENABLED') && utilityProvider !== 'http') {
    errors.push('PRODUCT_UTILITIES_PRODUCTION_ENABLED requires UTILITY_PROVIDER=http.');
  }

  const loadProvider = (env.LOAD_SHEDDING_PROVIDER?.trim() || 'db').toLowerCase();
  if (!['db', 'http'].includes(loadProvider)) {
    errors.push('LOAD_SHEDDING_PROVIDER must be db or http.');
  }
  if (loadProvider === 'http') {
    const feed = required('LOAD_SHEDDING_FEED_URL');
    if (feed) httpsUrl('LOAD_SHEDDING_FEED_URL', feed);
  }

  const monitoringProvider = required('MONITORING_PROVIDER').toLowerCase();
  if (!['sentry', 'datadog', 'other'].includes(monitoringProvider)) {
    errors.push('MONITORING_PROVIDER must be sentry, datadog, or other.');
  }
  required('MONITORING_DSN');
  required('ALERT_ROUTING_MARKER');

  const sanctionsProvider = required('SANCTIONS_PEP_PROVIDER').toLowerCase();
  if (!['http', 'external'].includes(sanctionsProvider)) {
    errors.push('SANCTIONS_PEP_PROVIDER must be http or external.');
  }
  const sanctionsEndpoint = required('SANCTIONS_PEP_ENDPOINT');
  if (sanctionsEndpoint) httpsUrl('SANCTIONS_PEP_ENDPOINT', sanctionsEndpoint);
  required('SANCTIONS_PEP_API_KEY');

  const auditSink = required('AUDIT_SINK_PROVIDER').toLowerCase();
  if (!['http', 'external'].includes(auditSink)) {
    errors.push('AUDIT_SINK_PROVIDER must be http or external.');
  }
  const auditEndpoint = required('AUDIT_SINK_ENDPOINT');
  if (auditEndpoint) httpsUrl('AUDIT_SINK_ENDPOINT', auditEndpoint);
  required('AUDIT_SINK_API_KEY');

  const storageProvider = required('PRIVATE_STORAGE_PROVIDER').toLowerCase();
  if (!['s3', 'gcs', 'azure', 'external'].includes(storageProvider)) {
    errors.push('PRIVATE_STORAGE_PROVIDER must be s3, gcs, azure, or external.');
  }
  const signingEndpoint = required('PRIVATE_STORAGE_SIGNING_ENDPOINT');
  if (signingEndpoint) httpsUrl('PRIVATE_STORAGE_SIGNING_ENDPOINT', signingEndpoint);
  required('PRIVATE_STORAGE_ENCRYPTION_KEY_REF');
  const scanner = required('MALWARE_SCANNER_PROVIDER').toLowerCase();
  if (!['clamav', 'vendor', 'external'].includes(scanner)) {
    errors.push('MALWARE_SCANNER_PROVIDER must be clamav, vendor, or external.');
  }
  required('MALWARE_SCANNER_CALLBACK_SECRET', 32);
  if (dataEncryptionKey) {
    const bytes = /^[a-f0-9]{64}$/iu.test(dataEncryptionKey)
      ? Buffer.from(dataEncryptionKey, 'hex')
      : Buffer.from(dataEncryptionKey, 'base64');
    if (bytes.length !== 32) errors.push('DATA_ENCRYPTION_KEY must encode exactly 32 bytes.');
  }

  const backupProvider = required('BACKUP_PROVIDER').toLowerCase();
  if (!['neon', 'render', 'external'].includes(backupProvider)) {
    errors.push('BACKUP_PROVIDER must be neon, render, or external.');
  }
  required('BACKUP_ENCRYPTION_MARKER');
  required('BACKUP_PITR_MARKER');
  required('BACKUP_VERIFICATION_MARKER');
  return errors;
}

/** Refuse startup in any staging/production-like environment when unsafe. */
export function validateProductionConfig(): void {
  const errors = collectProductionConfigErrors(process.env);
  if (errors.length > 0) {
    throw new Error(`Invalid deployed configuration:\n- ${errors.join('\n- ')}`);
  }
}
