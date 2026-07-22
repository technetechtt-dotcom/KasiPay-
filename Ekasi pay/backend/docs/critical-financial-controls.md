# Critical financial controls (current package)

## Implemented

1. **Integer money** — PostgreSQL amounts use `*_cents BIGINT` via migrations `002`/`003`; shared `money.ts` rejects unsupported precision.
2. **Immutable balanced ledger** — migration `004`; posting engine in `walletPostingPg.ts` with journal entries, projections, reversals.
3. **Compulsory atomic idempotency** — `Idempotency-Key` required on money routes; request hash + lifecycle in `payment_idempotency`. Expired leases are **not** reclaimed when `posting_id` is set (crash-after-post recovers the completed response instead of double-posting). Response persistence failures fail closed.
4. **PostgreSQL-only production** — `DATABASE_URL` mandatory outside development/test; SQLite is local-only.
5. **Versioned migrations** — `backend/migrations/*` with `npm run migrate:*` and startup schema readiness.
6. **Encrypted Cash Send / KYC PII** — Cash Send SA IDs and addresses encrypted at rest with key versioning (`vN.…` ciphertext; `DATA_ENCRYPTION_KEY_PREVIOUS` for rotation). Migration `010` adds encrypted columns; `npm run cash-send:backfill-pii` clears plaintext; migration `011` drops plaintext columns. KYC blobs blocked in production; signed private-object upload required; merchant approval requires `scan_state = clean` on all required docs.
7. **No merchant document bypass** — approval requires all four document types **malware-clean** and not deleted; override removed.
8. **Operator MFA + RBAC** — TOTP MFA; roles with deny-by-default capabilities. Maker-checker adapters consume approved requests for loan disbursement, insurance payout, refunds, and user role changes (`lockApprovedRequest` / `markApprovalExecuted`).
9. **Financial concurrency / invariant tests** — `ledgerPg.integration.test.ts` (requires `TEST_DATABASE_URL`); unit coverage for money, idempotency hashing, encryption.
10. **Disabled products (fail closed outside local)**
    - `LENDING_ENABLED` / loan apply-disburse-repay
    - `INSURANCE_ENABLED`
    - `STOKVEL_MONEY_MOVEMENT_ENABLED` (custodial contributions/loans/repay including `/regulated/stokvel/...`)
    - `CASH_SEND_ENABLED` (create/collect/cancel)
    - Clients show disabled notices; `GET /api/runtime-controls` exposes flags.
11. **P2P transfer refunds** — users cannot claw back transfers; operator + maker-checker approval required.
12. **`postBetweenWalletsPg`** accepts only `PoolClient` (transactional). Use `postBetweenWalletsWithRetryPg` when starting from a `Pool`.

## Enable only with explicit env (never default on in production)

```bash
CASH_SEND_ENABLED=true
LENDING_ENABLED=true
INSURANCE_ENABLED=true
STOKVEL_MONEY_MOVEMENT_ENABLED=true
```

Plus regulated readiness evidence where Phase 7 gates apply.

## Production readiness script

`npm run production:ready` (see [phase8-release.md](./phase8-release.md)) fails
closed when any of the product flags above is `true` without a matching
`approved`/`passed` entry in `evidence/production-readiness.json`
(`productFlags`). Use
`evidence/production-readiness.example.json` as a template — never invent
approvals.
