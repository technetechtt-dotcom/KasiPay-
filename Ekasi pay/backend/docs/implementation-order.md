# Implementation order

Ship by direct push to `main`. Do not open pull requests or feature branches.
Money-movement flags stay **false** until the last step has named external evidence.

| # | Work | Status |
|---|---|---|
| 1 | Fix OTP logging, health checks, and deployment-mode handling | Shipped |
| 2 | Protect `main` and gate Render deploys on CI (`checksPass`) | Shipped in repo — not a PR merge gate |
| 3 | Migrate and verify the production database | Verified 2026-08-21: migrations 001–019 applied on Neon production |
| 4 | Harden authentication rate limiting and secret management | Shipped — IP+phone auth keys, `trust proxy`, non-funds secret derivation |
| 5 | Repair the reconciliation worker | Shipped — start log first, skip missing schema, non-funds job set |
| 6 | Redesign the offline outbox | Shipped — v2 backoff, tab lock, 409 = success |
| 7 | Complete KYC, monitoring, backups, and incident response | Partial in-repo; live vendors still external |
| 8 | Run a non-funds merchant pilot | Ready for field — `docs/non-funds-pilot-rehearsal.md` |
| 9 | Obtain external security, accounting, and regulatory assurance | Open — cannot complete from git |
| 10 | Only then enable limited real-money functionality | Blocked |
| 11 | Secret scanning + maker/checker for activation waivers | Shipped — gitleaks CI, `merchant_activation_waiver` |
| 12 | R9/R6/R3 Cash Send + R600 activation | Shipped — fee v2, statements, activation APIs |
| 13 | POS receipts, discounts, sale voids | Shipped |
| 14 | Playwright E2E for login / POS / Cash Send entry | Shipped — mocked API, Chromium in CI |
| 15 | Live Neon 017–019 + gitleaks evidence + agent-network design | Proven 2026-08-21 — see `docs/next-priority-evidence.md` |

## Step 3 evidence

`npm run schema:verify` on Neon production (2026-08-21): 19 migrations, 171 public tables, required objects present. 019 was applied that day after it was found missing. Confirm Render `ekasi-pay-api` and `ekasi-pay-reconcile-worker` still use that same URL — worker leases on this DB are empty.

## Still external (7 / 9 / 10)

Pen-test, accounting sign-off, POPIA/FICA opinion, live SMS/Sentry/Redis/KYC storage, IR tabletop, and funds flags. Track in `external-assurance-track.md`. Do not set `FINANCIAL_POSTING_ENABLED=true`.
