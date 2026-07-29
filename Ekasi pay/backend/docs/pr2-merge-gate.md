# Merge gate for PR #2

Tip SHA must be CI-green. GitHub blocks self-approval for CODEOWNERS.

## Merge steps (human CODEOWNER other than the pusher, or temporarily adjust review rules)

1. Open https://github.com/technetechtt-dotcom/KasiPay-/pull/2
2. Confirm checks: validate, secret-scan, codeql, sbom, mobile-web-build, mobile-ios-verify, ops-dashboard
3. Approve as CODEOWNER (`@technetechtt-dotcom`)
4. Merge (squash or merge commit — linear history is required)
5. Sync Render blueprint so `ekasi-pay-reconcile-worker` is created and given `DATABASE_URL`
6. Confirm worker logs show `reconciliation.worker_started`

## After merge

- `main` becomes the release-evidence tip
- Keep all regulated product flags and `FINANCIAL_POSTING_ENABLED` false
- Run `npm run alerts:verify` against staging MONITORING_DSN when configured
