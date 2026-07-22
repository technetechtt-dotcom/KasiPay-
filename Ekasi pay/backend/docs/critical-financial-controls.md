# Critical financial controls (current package)

## Implemented

1. **Integer money** — PostgreSQL amounts use `*_cents BIGINT` via migrations `002`/`003`; shared `money.ts` rejects unsupported precision.
2. **Immutable balanced ledger** — migration `004`; posting engine in `walletPostingPg.ts` with journal entries, projections, reversals.
3. **Compulsory atomic idempotency** — `Idempotency-Key` required on money routes; request hash + lifecycle in `payment_idempotency`.
4. **PostgreSQL-only production** — `DATABASE_URL` mandatory outside development/test; SQLite is local-only.
5. **Versioned migrations** — `backend/migrations/*` with `npm run migrate:*` and startup schema readiness.
6. **Encrypted Cash Send / KYC PII** — Cash Send SA IDs and addresses encrypted at rest (`010_encrypt_cash_send_pii.js` + `fieldEncryption.ts`); blind hashes for matching; ops lists masked. KYC blobs blocked in production; signed private-object upload required.
7. **No merchant document bypass** — approval requires all four document types; override removed.
8. **Operator MFA + RBAC** — TOTP MFA; roles `admin|operations|compliance|finance|support` with deny-by-default capabilities.
9. **Financial concurrency / invariant tests** — `ledgerPg.integration.test.ts` (requires `TEST_DATABASE_URL`); unit coverage for money, idempotency hashing, encryption.
10. **Disabled products (fail closed outside local)**
    - `LENDING_ENABLED` / loan apply-disburse-repay
    - `INSURANCE_ENABLED`
    - `STOKVEL_MONEY_MOVEMENT_ENABLED` (custodial contributions/loans/repay)
    - `CASH_SEND_ENABLED` (create/collect/cancel)
    - Clients show disabled notices; `GET /api/runtime-controls` exposes flags.

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
