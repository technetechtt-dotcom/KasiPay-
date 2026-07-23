# External assurance blockers

These items cannot be completed from the repository alone. They remain required
before enabling regulated products or live customer funds.

| Item | Owner | Status |
|---|---|---|
| External accounting / ledger model review | Named finance auditor | **Blocked** — use `docs/accounting-signoff-template.md` + drift proposal digests |
| External penetration test + high-severity remediation | Named security firm | **Blocked** |
| Certified providers (payment, utility, SMS, sanctions, KYC storage, malware, audit) | Product + provider | **Blocked** — adapters exist; live contracts required |
| Insurance / lending partner certification | Product + legal | **Blocked** — flags stay `false` |
| POPIA / FICA / payment-services legal advice | Legal | **Blocked** |
| Production Redis / monitoring / audit sink / private KYC | Platform ops | Env keys declared; live wiring pending |
| Host restore drill + measured RTO/RPO | Platform ops | Neon branch drill exists; recurring encrypted host drills pending |
| Merchant pilot / payments go-live | Product | Phases 9–11 — not started for funds |

## GitHub controls (truthful status)

Configured by `npm run github:configure-controls`:

- Protected `main` with **enforce_admins**
- Required PR reviews + **CODEOWNERS** for financial/security paths
- Required CI checks: validate, secret-scan, codeql, sbom, mobile/ops builds
- Staging + production environments (add required reviewers in GitHub UI)
- Dependency graph / Dependabot alerts enabled via API when permitted
- `dependency-review` is **hard-fail** on PRs (no `continue-on-error`)

Direct pushes to `main` are **blocked** while this protection is active.

## Engineering scaffolding

- Drift inventory / remediation / zero-drift proof scripts
- Maker-checker align + posting re-enable approvals
- Dedicated reconcile worker (`npm run reconcile:worker`) with leases — not in API process
- Journal/projection failures are **critical** and disable posting
- Immutable drift remediation proposals (migration `015`)
- Safe PII deploy: `npm run migrate:deploy`
- Versioned `PII_HASH_PEPPER`

## Still keep disabled

`FINANCIAL_POSTING_ENABLED`, `CASH_SEND_ENABLED`, `LENDING_*`, `INSURANCE_ENABLED`,
`STOKVEL_MONEY_MOVEMENT_ENABLED`, `LIVE_UTILITIES_ENABLED` — all remain false until
evidence is approved.
