# Main branch ops gate

Release evidence is the CI-green tip of `main` (direct pushes allowed; force-push blocked).

## After each money-control push to `main`

1. Confirm Actions on the tip SHA: validate, secret-scan, codeql, sbom, mobile-web-build, mobile-ios-verify, ops-dashboard
2. Sync Render blueprint so `ekasi-pay-reconcile-worker` exists with:
   - `DATABASE_URL` (same Neon DB as API)
   - `MONITORING_PROVIDER`, `MONITORING_DSN`, `ALERT_ROUTING_MARKER` (same as API)
   - All regulated product flags `false`
3. Confirm worker logs show `reconciliation.worker_started`
4. Keep `FINANCIAL_POSTING_ENABLED=false` until production-readiness evidence is approved
5. Run `npm run alerts:verify` against staging `MONITORING_DSN` when configured
6. Help contacts: `VITE_SUPPORT_EMAIL` is set in the blueprint (email-only is enough; do not invent phone numbers)
6b. Confirm `FRONTEND_ORIGINS` on `ekasi-pay-api` includes `https://ekasi-ops-dashboard.onrender.com` (blueprint default + `OPS_DASHBOARD_ORIGIN`)
7. Run `npm run ops:prove-public` (no secrets) then `npm run ops:verify-live` with Render/Neon/monitoring env loaded; confirm worker log `reconciliation.worker_started`
8. Track parallel external work in `docs/external-assurance-track.md` (never invent approvals)
9. Neon project `KasiPay` / production branch is the intended DB; confirm Render `DATABASE_URL` points at it before treating worker as live
10. Use `docs/non-funds-pilot-rehearsal.md` for the merchant rehearsal (flags stay false)
11. Before enabling ops/reconcile features against Neon, run `npm run migrate:status` and `npm run schema:verify`. The configured Neon URL had migrations 001–016 applied as of 2026-08-12. Confirm Render `DATABASE_URL` is that same database before treating the worker as live.

## Branch policy

- **Always push to `main`.** Do not use pull requests or feature branches for this repo.
- Direct pushes to `main` are allowed; **force-push stays blocked**
- Render services use `autoDeployTrigger: checksPass` so a red CI job does not auto-deploy
- CI still runs on every push; confirm green on the tip SHA before treating it as release-proven
- Do not enable custodial money movement from docs alone — see `external-assurance-blockers.md`
