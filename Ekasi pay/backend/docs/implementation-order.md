# Implementation order

Ship by direct push to `main`. Do not open pull requests or feature branches.
Money-movement flags stay **false** until the last step has named external evidence.

| # | Work | Status |
|---|---|---|
| 1 | Fix OTP logging, health checks, and deployment-mode handling | Shipped |
| 2 | Protect `main` and gate Render deploys on CI (`checksPass`) | Shipped in repo — not a PR merge gate |
| 3 | Migrate and verify the production database | Verified on the configured Neon URL: migrations 001–016 applied |
| 4 | Harden authentication rate limiting and secret management | Shipped — IP+phone auth keys, `trust proxy`, non-funds secret derivation |
| 5 | Repair the reconciliation worker | Shipped — start log first, skip missing schema, non-funds job set |
| 6 | Redesign the offline outbox | Shipped — v2 backoff, tab lock, 409 = success |
| 7 | Complete KYC, monitoring, backups, and incident response | Partial in-repo; live vendors still external |
| 8 | Run a non-funds merchant pilot | Ready for field — `docs/non-funds-pilot-rehearsal.md` |
| 9 | Obtain external security, accounting, and regulatory assurance | Open — cannot complete from git |
| 10 | Only then enable limited real-money functionality | Blocked |

## Step 3 evidence

`npm run migrate:status` and `npm run schema:verify` against the local `DATABASE_URL` (Neon) show 001–016 up and required ops/ledger tables present. Confirm Render `ekasi-pay-api` and `ekasi-pay-reconcile-worker` use that same URL.

## Still external (7 / 9 / 10)

Pen-test, accounting sign-off, POPIA/FICA opinion, live SMS/Sentry/Redis/KYC storage, IR tabletop, and funds flags. Track in `external-assurance-track.md`. Do not set `FINANCIAL_POSTING_ENABLED=true`.
