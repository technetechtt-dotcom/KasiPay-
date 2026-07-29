# External assurance blockers

These items cannot be completed from the repository alone. They remain required
before enabling regulated products or live customer funds.

| Item | Owner | Status |
|---|---|---|
| External accounting / ledger model review | Named finance auditor | **Blocked** — use drift proposal digests + `docs/accounting-signoff-template.md` |
| External penetration test + high-severity remediation | Named security firm | **Blocked** |
| Certified providers (payment, utility, SMS, sanctions, KYC storage, malware, audit) | Product + provider | **Blocked** — adapters exist; live contracts required |
| Insurance / lending partner certification | Product + legal | **Blocked** — flags stay `false` |
| POPIA / FICA / payment-services legal advice | Legal | **Blocked** |
| Production Redis / monitoring / audit sink / private KYC | Platform ops | Env keys declared; live wiring pending |
| Host restore drill + measured RTO/RPO | Platform ops | Neon branch drill exists; recurring encrypted host drills pending |
| Incident-response tabletop + on-call roster | Ops | Alerts table + structured `pageOnCall` logs exist; exercise pending |
| Production-like load + live settlement rehearsal | Ops + finance | k6 scripts exist; live rehearsal pending |
| Merchant pilot / payments go-live | Product | Phases 9–11 — pilot UI scaffolding only; no funds |

## CI evidence (truthful)

| Ref | Proof |
|---|---|
| `main` @ `27ca5b5` (and later) | Hardening branch fast-forwarded to `main` after PR #2 closed. Treat CI green on the exact `main` tip SHA as the release-evidence tip. |
| Closed PR #2 | Historical review surface only — not a live merge gate. |

Current branch protection (see `npm run github:configure-controls`):

- Protected `main` with **enforce_admins** and required CI status checks
- **Force-push to `main` remains blocked**
- Direct pushes to `main` are **allowed** (PR reviews not required)
- CODEOWNERS retained for path ownership / review guidance on PRs when used
- `dependency-review` hard-fails on pull requests when Dependency graph is enabled

## Engineering scaffolding (in-repo)

- Dedicated Render worker `ekasi-pay-reconcile-worker` + `npm run reconcile:worker`
- Worker must share `MONITORING_*` / `ALERT_ROUTING_MARKER` with the API so fail-closed pages reach on-call
- Ops dashboard queues reconcile and shows exceptions / alerts / proposals
- Admin `/admin/reconciliation/run` is enqueue-only (no in-API inventory)
- Journal / projection / wallet / voucher / fee / commission / refund / settlement / provider / suspense / loan / insurance checks
- Any money-integrity failure → `failed` (never `partial`), disable posting, critical exception, on-call alert
- Immutable drift proposals with evidence digest; execute rejects if live values change
- IR + fraud playbook templates under `docs/playbook-*.md`
- Safe PII deploy: `npm run migrate:deploy`
- Post-merge ops steps: `docs/main-ops-gate.md`

## Still keep disabled

`FINANCIAL_POSTING_ENABLED`, `CASH_SEND_ENABLED`, `LENDING_*`, `INSURANCE_ENABLED`,
`STOKVEL_MONEY_MOVEMENT_ENABLED`, `LIVE_UTILITIES_ENABLED` — all remain false until
evidence is approved.
