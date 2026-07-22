# Phase 6 completion audit

Date: 2026-07-21

## Implemented

- Migration `007_phase6_settlement_provider_fees.js` installs settlement
  accounts/batches/payouts, statement files/items/matches, suspense cases/events,
  daily close evidence, alerts, fee schedules/tiers/assessments/components,
  refunds, provider endpoints/instructions/attempts/callback inbox/dead letters
  and circuit state.
- Settlement import enforces the canonical CSV schema, hashes original and
  canonical content, rejects duplicate files/rows, deterministically classifies
  exact/partial/duplicate/unmatched items, and journals breaks to suspense.
- Finance APIs enforce separate maker/checker identities for settlement-account
  verification, batch approval, suspense resolution, daily close sign-off and
  fee schedule publication.
- Fee calculation is server-side integer-cent arithmetic with effective
  versions, tiers, basis points, min/max and exact liability allocation.
- Cash Send route constants were removed. Fee accrual and cancellation/expiry
  clawback are real linked journals; collection no longer double-pays the fee.
- Generic full/partial wallet refunds enforce remaining ceiling,
  idempotency and high-value approval, and create linked compensating journals.
- Provider framework includes canonical hashes, HMAC signing, timestamp/replay
  checks, attempt journal, timeout-to-unknown, bounded jitter, status re-query,
  dead-letter/circuit schema and sandbox/production separation.
- Utility purchase now commits value authorization and provider instruction
  before fulfillment, reverses definitive failures and reserves unknown
  outcomes for re-query.
- Ops dashboard includes statement import, break visibility, journal references
  and settlement/fee counts.
- Simulator/unit tests cover strict files, deterministic matching, fee math,
  signing, replay age, idempotency, callback payload changes and unknown
  recovery. PostgreSQL integration tests cover Phase 6 schema, duplicate file
  hashes, callback duplicates and seeded fee versions.

## Verification evidence

- Backend tests: 76 passed; PostgreSQL suites discovered but skipped locally
  because `TEST_DATABASE_URL` was intentionally not pointed at a live database.
- Backend TypeScript: passed.
- Backend build: passed.
- Migration source/order validation: 7 migrations passed.
- Backend smoke: passed using an isolated SQLite database and console SMS.
- Changed backend-file ESLint: passed.
- Frontend tests: 59 passed.
- Frontend TypeScript and build: passed.
- Ops dashboard TypeScript and build: passed.

Safety incident during verification: the first smoke attempt inherited local
Twilio settings and made two rejected trial-account requests to an unverified
number; no SMS was delivered. The smoke harness now forcibly sets
`SMS_PROVIDER=console` and `UTILITY_PROVIDER=mock`, and the passing rerun used
only those isolated adapters.

## Residual blockers

- A local PostgreSQL/Docker service was unavailable, so migration execution and
  PostgreSQL integration assertions must run in CI's PostgreSQL 16 service.
- No live Neon migration was attempted.
- No real bank mapping or provider certification exists. The canonical importer
  is deliberately not a claim of compatibility with any bank's native file.
- SMS and KYC remain on their existing adapters. Moving them requires provider
  status/idempotency contracts; fabricating those semantics would create unsafe
  success or duplicate-delivery behavior.
- Generic refund execution is limited to wallet-backed journal postings.
  Consumed utilities, lending, insurance and proportional stock restoration
  require product/provider eligibility decisions and verified domain-specific
  compensation handlers.
- Production endpoint provisioning, managed signing-key references, callback
  secrets, monitoring routes, holiday calendars, settlement SLAs and finance
  tax/VAT approval remain deployment gates.

These blockers are certification/configuration work, not replaced with fake
production behavior.
