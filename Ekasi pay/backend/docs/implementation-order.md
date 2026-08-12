# Implementation order

Ship by direct push to `main`. Do not open pull requests or feature branches.
Money-movement flags stay **false** until the last step has named external evidence.

| # | Work | Status |
|---|---|---|
| 1 | Fix OTP logging, health checks, and deployment-mode handling | Shipped — OTP/SMS logs redacted; `/health` reports `nonFunds`; Render unset flags = non-funds |
| 2 | Protect `main` (force-push blocked) and gate Render deploys on CI (`autoDeployTrigger: checksPass`) | In progress — not a PR merge gate |
| 3 | Migrate and verify the production database | Open — operator: `migrate:status` then planned `migrate:deploy` |
| 4 | Harden authentication rate limiting and secret management | Open |
| 5 | Repair the reconciliation worker | Open |
| 6 | Redesign the offline outbox | Open |
| 7 | Complete KYC, monitoring, backups, and incident response | Open — mostly external vendors |
| 8 | Run a non-funds merchant pilot | Open — `docs/non-funds-pilot-rehearsal.md` |
| 9 | Obtain external security, accounting, and regulatory assurance | Open — `docs/external-assurance-track.md` |
| 10 | Only then enable limited real-money functionality | Blocked |

## Step 1 notes

- Console SMS and PIN/OTP routes must not log codes, SMS bodies, or raw phones.
- `/health` and `/health/live` report `nonFunds`. `/health/ready` skips backup/Redis in non-funds mode.
- Render with unset money flags is treated as non-funds (`RENDER=true`).

## Step 2 notes

- Direct pushes to `main` stay allowed.
- Render deploys wait for GitHub CI (`checksPass`). Manual Deploy can still ship a SHA if Auto-Deploy is stuck.
