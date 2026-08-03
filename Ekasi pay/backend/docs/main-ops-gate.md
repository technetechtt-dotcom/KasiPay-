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
6. Set real `VITE_SUPPORT_*` on the web service before pilot Help contacts go live
7. Run `npm run ops:verify-live` with Render/Neon/monitoring env loaded; confirm worker log `reconciliation.worker_started`
8. Track parallel external work in `docs/external-assurance-track.md` (never invent approvals)
9. Neon project `KasiPay` / production branch is the intended DB; confirm Render `DATABASE_URL` points at it before treating worker as live
10. Use `docs/non-funds-pilot-rehearsal.md` for the merchant rehearsal (flags stay false)
11. Before enabling ops/reconcile features against Neon, run `npm run migrate:status` — as of 2026-08-03 the Neon production branch still lacks `schema_migrations` and Phase 4+ tables (ops approvals, fail-closed reconcile). Do **not** point a green `main` API at that DB until `migrate:deploy` is planned and evidenced.

## Branch policy

- Direct pushes to `main` are allowed; **force-push stays blocked**
- CI still runs on every push; confirm green on the tip SHA before treating it as release-proven
- Do not enable custodial money movement from docs alone — see `external-assurance-blockers.md`
