# Phase 4 security and privacy baseline

This document describes engineering controls, not legal certification or proof of
operational effectiveness.

## Implemented in code

- Deny-by-default operator roles (`admin`, `operations`, `compliance`, `finance`,
  `support`) and named endpoint capabilities. Legacy `super_admin` maps to
  `admin`; legacy `operator` maps to least-privileged `support`. Unknown roles
  receive no capabilities.
- PostgreSQL operator sessions/devices, ten-minute access tokens, refresh
  rotation with family reuse revocation, token-version revocation, password plus
  TOTP, a passkey-ready method field, session listing/revocation, and five-minute
  step-up records.
- One-time audited operator bootstrap CLI. Normal startup never creates or
  synchronizes an operator from environment variables.
- Durable maker/checker requests and immutable events with distinct actors,
  reason, evidence, expiry and terminal state constraints. Controlled action
  types cover disbursement, adjustments, overrides, reversals, user roles, and
  limits. Action adapters must consume an approved request transactionally.
- Keyed recovery-code hashes, generic request responses, expiry, attempt,
  resend/daily throttles, atomic consume, notification outbox records, token
  version increment, full session revocation and a post-recovery policy hold.
- Six-to-twelve digit PINs for new/reset/changed PINs. Four-digit legacy PINs
  remain accepted only at login until customers rotate them.
- Private KYC object keys and short-lived signed URL abstraction; MIME, byte
  signature and size validation; scan/quarantine lifecycle; encryption key
  reference; case assignment, audit, retention and deletion-job schema.
  Production rejects database-blob upload and fails configuration validation
  without private storage and malware scanner settings.
- Strict API CSP/security headers, cookie refresh with double-submit CSRF,
  explicit bearer-refresh compatibility switch, in-memory browser access tokens,
  native secure-storage abstraction, and expanded log redaction.
- Versioned consent and data-subject request APIs with append-only request
  events, plus a vendor/cross-border register schema.

## Required provider and operational work

The repository does not connect to live providers. Before production:

1. Configure a private storage signing service and provider-side encryption.
2. Connect a malware scanner callback/worker that transitions `pending` to
   `clean` or `quarantined`; monitor its backlog and failures.
3. Install and verify a Capacitor secure-storage plugin implementing
   `SecureStoragePlugin`; release builds intentionally fail when absent.
4. Enroll every operator's TOTP secret, retain recovery procedures offline, and
   run access recertification. Passkeys remain an explicit future provider.
5. Build and approve execution adapters for each maker/checker action. No
   controlled operation may execute merely because a request row is approved.
6. Schedule retention/deletion and notification-outbox workers.
7. Obtain privacy, employment, financial-services and incident-response legal
   review. No POPIA compliance claim is made here.

## Deployment gates

- Apply migration `005_security_privacy_baseline.js` in a rehearsed branch.
- Run `npm run bootstrap:operator` once with explicit confirmation.
- Set distinct JWT, refresh, recovery, operator-refresh, signing and callback
  secrets. Rotate any secret ever used in development.
- Keep `BEARER_REFRESH_COMPATIBILITY=false` for browsers after cookie rollout.
- Set `ALLOW_LEGACY_DB_KYC_UPLOAD=false`; migrate legacy blobs only through an
  approved, checksummed and audited migration job.
