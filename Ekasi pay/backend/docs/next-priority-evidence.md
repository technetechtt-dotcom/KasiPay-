# Next-priority evidence (2026-08-21)

Money-movement flags stay **false**. This file records what was proven from
Neon / live health / git, and what still needs a human or a vendor.

## 1. Migrations 017–019 on live Neon

**Proven.** Neon project `KasiPay` (`purple-unit-69145144`), production branch
`br-falling-truth-add7cqi1`, host
`ep-old-resonance-adtwdgrj-pooler.c-2.us-east-1.aws.neon.tech`.

| Migration | Applied at (UTC) |
|---|---|
| 017_commercial_launch | 2026-08-19T11:35:32Z |
| 018_cash_send_r9_pricing | 2026-08-19T11:40:05Z |
| 019_sale_voids_activation_approvals | 2026-08-21T10:18:04Z |

`npm run schema:verify` on that URL: `public_tables=171`,
`schema_migrations=19`, `missing=none`. Sale void / receipt columns and
activation waiver columns exist after 019.

019 was missing until today. CI on `main` was red (History page lint), so
Render `checksPass` would not have auto-deployed it.

## 2. Render API and reconcile worker share the same DB

**Partial.**

| Check | Result |
|---|---|
| Local `DATABASE_URL` host | Same Neon production pooler as above |
| Live API `GET /health/ready` | `database: ready`, `nonFunds: true` |
| `reconciliation_job_leases` | Empty |
| `reconciliation_runs` | 0 rows |

The API is using a reachable Postgres. The worker has **not** written a lease
or a run on this database, so worker `DATABASE_URL` equality is still unproven.
In the Render dashboard, copy the **same** Neon URL onto both
`ekasi-pay-api` and `ekasi-pay-reconcile-worker`. Then confirm worker logs show
`reconciliation.worker_started`.

## 3. Exposed ops admin credential rotation

**Not proven.** Operator `ivanij` (`admin`) on Neon:

- `password_changed_at` = 2026-08-07T10:04:13Z (unchanged since bootstrap)
- `mfa_enabled_at` = 2026-08-18T10:36:57Z
- `last_login_at` = 2026-08-19T09:04:48Z
- `token_version` = 4

`npm run ops:rotate-operator` sets `password_changed_at = NOW()`. That did not
happen after the committed reset helper was removed. Rotate it from a machine
that has `DATABASE_URL`, without committing the password:

```bash
cd "Ekasi pay/backend"
ROTATE_CONFIRM=ROTATE_OPERATOR \
ROTATE_OPERATOR_USERNAME=ivanij \
ROTATE_OPERATOR_PASSWORD='<new 14+ char secret>' \
ROTATE_RESET_MFA=1 \
npm run ops:rotate-operator
```

Treat any password that ever lived in git as burned.

## 4. Gitleaks / secret scan

**Proven clean (this scan).** Local gitleaks 8.21.2, 103 commits, no leaks.
Evidence: `docs/evidence/gitleaks-2026-08-21.txt`. CI job `secret-scan` still
runs on every push; retain the GitHub Actions log for the green tip SHA.

## 5. Production Redis

**Not configured.** Live `/health/ready` reports
`redis: { configured: false, healthy: false }`.

Create a Render Key Value instance (Redis), then set `RATE_LIMIT_REDIS_URL` on
`ekasi-pay-api` only. Do not commit the URL. Restart and confirm
`configured: true` and `healthy: true` on `/health/ready`.

## 6. Monitoring and alert routing

**Not configured.** `MONITORING_DSN`, `MONITORING_PROVIDER`, and
`ALERT_ROUTING_MARKER` are unset in the local ops env and still `sync: false`
on the blueprint. Create a Sentry (or webhook) project, paste the DSN onto
**both** API and reconcile worker, set `ALERT_ROUTING_MARKER`, then run
`npm run alerts:verify`.

## 7. Database restore drill

**Neon PITR fork proven; encrypted host dump drill still open.**

Fork `restore-drill-2026-08-21` (`br-cool-heart-adryjyas`) was readable:
18 migrations, 4 wallets, 3 journals. It expires 2026-08-23. Full JSON:
`docs/evidence/neon-restore-drill-2026-08-21.json`.

Still required before funds: encrypted `pg_dump` / `pg_restore` isolated drill
and a `backup_verification_markers` row (currently 0).

## 8. Physical Android / offline testing in 5 shops

**Cannot be done from git.** Use `docs/non-funds-pilot-rehearsal.md`. Flags stay
false.

## 9–13. Cash Send network design

**Decided in-repo** — see `docs/cash-send-agent-network.md`. Code still pays
the full R3 to the sending shop at voucher create. Do not change live posting
until the payout-shop role and float accounts exist.

## 14–20. Vendors, legal, pentest, real-money pilot

**Blocked / external.** Track owners in `external-assurance-track.md`. Do not
set `CASH_SEND_ENABLED` or `FINANCIAL_POSTING_ENABLED` until those rows have
named evidence URIs.
