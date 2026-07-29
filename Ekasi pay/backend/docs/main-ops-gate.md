# Main branch ops gate (post-merge)

PR #2 is closed. Release evidence is the CI-green tip of `main`.

## After each money-control push to `main`

1. Confirm Actions on the tip SHA: validate, secret-scan, codeql, sbom, mobile-web-build, mobile-ios-verify, ops-dashboard
2. Sync Render blueprint so `ekasi-pay-reconcile-worker` exists with:
   - `DATABASE_URL` (same Neon DB as API)
   - `MONITORING_PROVIDER`, `MONITORING_DSN`, `ALERT_ROUTING_MARKER` (same as API)
   - All regulated product flags `false`
3. Confirm worker logs show `reconciliation.worker_started`
4. Keep `FINANCIAL_POSTING_ENABLED=false` until production-readiness evidence is approved
5. Run `npm run alerts:verify` against staging `MONITORING_DSN` when configured

## Branch policy

- Direct pushes to `main` are allowed; **force-push stays blocked**
- CI still runs on every push; confirm green on the tip SHA before treating it as release-proven
- Do not enable custodial money movement from docs alone — see `external-assurance-blockers.md`
