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
| Merchant pilot / payments go-live | Product | Phases 9–11 — not started for funds |

## CI evidence (truthful)

| Ref | Proof |
|---|---|
| PR tip `harden/phases-1-5-controls` | CI green for validate (migrations + PG tests + zero-drift), secret-scan, CodeQL, SBOM, mobile, ops-dashboard — see PR #2 |
| `main` | **Unverified until PR #2 is CODEOWNER-approved and merged.** Do not treat `main` HEAD as release-proven while it trails the hardening branch. |

Required branch protection (configured by `npm run github:configure-controls`):

- Protected `main` with **enforce_admins**
- Required PR reviews + **CODEOWNERS** for financial/security paths
- Required CI checks; `dependency-review` hard-fails on PRs
- Direct pushes to `main` are **blocked**

## Engineering scaffolding (in-repo)

- Dedicated `npm run reconcile:worker` with leases + job queue — **not** in the API process
- Journal / projection / wallet / voucher / fee / commission / refund / settlement / provider / suspense / loan / insurance checks
- Any money-integrity failure → `failed` (never `partial`), disable posting, critical exception, on-call alert
- Immutable drift proposals with wallet/journal/projection/delta/accounts/root-cause/evidence digest; execute rejects if live values change
- Safe PII deploy: `npm run migrate:deploy`

## Still keep disabled

`FINANCIAL_POSTING_ENABLED`, `CASH_SEND_ENABLED`, `LENDING_*`, `INSURANCE_ENABLED`,
`STOKVEL_MONEY_MOVEMENT_ENABLED`, `LIVE_UTILITIES_ENABLED` — all remain false until
evidence is approved.
