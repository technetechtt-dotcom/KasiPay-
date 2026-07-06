export const FEATURE_FLAGS = {
  enableAuthLockout: true,
  /** UI pin lockout window (ms). Server access JWT TTL is controlled by `ACCESS_TOKEN_TTL_SEC`. */
  sessionTtlMs: 12 * 60 * 60 * 1000,
  maxAuditEvents: 200
} as const;
