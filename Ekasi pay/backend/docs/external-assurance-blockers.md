# External assurance blockers

These items cannot be completed from the repository alone. They remain required
before enabling regulated products or live customer funds.

| Item | Owner | Status |
|---|---|---|
| External accounting / ledger model review | Named finance auditor | **Blocked** — schedule review against `docs/critical-financial-controls.md`, drift remediation artifacts, and reconcile script outputs |
| External penetration test + high-severity remediation | Named security firm | **Blocked** — engage after staging with production-like data |
| Certified payment / utility / cash-in-out / SMS / sanctions / KYC storage / malware / audit sink partners | Product + provider | **Blocked** — adapters and fail-closed config exist; live contracts + certification evidence required |
| Insurance and lending partner certification | Product + legal | **Blocked** — product flags stay `false` until evidence is approved |
| Private KYC object storage + malware scanner live wiring | Platform ops | Adapters + **dev stubs** (`npm run dev:storage-signer`, `npm run dev:malware-scan`); production credentials still required |
| Centralized monitoring alert routing proof | Platform ops | Run `npm run alerts:verify` with real DSN; confirm on-call page |
| Immutable audit sink live destination | Platform ops | HTTP sink + `npm run audit:deliver` wired; needs real `AUDIT_SINK_*` |
| Settlement end-to-end with live provider statements | Finance ops | Synthetic proof: `npm run settlement:e2e-proof`; live bank files still blocked |
| Production money contract sign-off | Finance + engineering | Run `npm run money:drift-inventory` / `money:remediate-drift` / `money:prove-zero-drift` on staging/prod-like DB; contract only after written sign-off |
| Host `pg_dump`/`pg_restore` restore drill | Platform ops | Use Neon branch fork + PITR evidence when `BACKUP_PROVIDER=neon` (`RESTORE_MODE=neon_branch`) |
| Shared Redis in production | Platform ops | `RATE_LIMIT_REDIS_URL` required; fail-closed when Redis is down; `/health/ready` pings Redis |
| Legal / regulatory + POPIA sign-off + IR tabletop | Legal + compliance | **Blocked** — outside repository |
| Production-like load / concurrency + restore + settlement rehearsal | Platform + finance | Engineering drills exist; live evidence still required |
| GitHub branch protection + production environment approvals | Platform ops | **Configured** on `main` (required checks + PR review); add environment reviewers + enable Dependency graph hard-fail |
| Written accounting sign-off | Named finance auditor | Template: `docs/accounting-signoff-template.md`; staging drift remediated to 0 on disposable branch |

## Engineering scaffolding added (2026-07-22+)

- Failure drills: `DRILL_ADAPTER=local npm run drill -- <type>`
- Settlement fixture E2E: `fixtures/settlement/phase6-v1.sample.csv`
- Audit outbox worker interval when `AUDIT_SINK_*` set at API boot
- Wallet/ledger drift inventory: `npm run money:drift-inventory`
- Auditable drift remediation (align ledger → wallet via suspense journals): `npm run money:remediate-drift`
- Consecutive zero-drift proof: `npm run money:prove-zero-drift`
- Automatic posting kill-switch on drift (`LEDGER_DRIFT_KILL_SWITCH`, default on outside local)
- Safe PII deploy sequence: `npm run migrate:deploy` (Render `preDeployCommand`)
- Dedicated versioned `PII_HASH_PEPPER` (no encryption-key fallback in deployed envs)
- Regional foundations: `src/i18n/regionConfig.ts`

## Staging branch drill notes (2026-07-22)

Disposable Neon branch `ci-harden-2026-07-22` (`br-small-bread-adccsed1`):

- Marked `001_baseline`, applied money expand + contract on a copy of production-like data.
- Column-level money conversion: **0 precision errors / 0 column mismatches**.
- Wallet↔legacy ledger reconcile: **FAIL** prior to remediation.
- **Origin of primary discrepancies (read-only analysis):**
  1. Two user wallets with `delta_cents = 100001000` — opening/`credit-wallet` style balance writes without matching `ledger_entries` (`opening_credit_without_ledger`).
  2. System escrow wallet `delta_cents = -2000` — Cash Send fee retention dual-write gap (`escrow_fee_retention_mismatch`).
  3. Additional `ledger-wallet-from-*` rows on the disposable branch are integration fixtures, not production customers.
- Remediation path: `ALLOW_DRIFT_REMEDIATION=1 DRIFT_REMEDIATION_APPROVAL=… npm run money:remediate-drift` then `npm run money:prove-zero-drift`.
- Migrations through `012` applied on the disposable branch after PII backfill; use `migrate:deploy` for brownfield 010→backfill→011–013.

Regulated product flags must remain `false` until the matching evidence rows are
approved in `evidence/production-readiness.json`.

## P2 roadmap (not go-live blockers)

Merchant operating system (offline POS, inventory, WhatsApp ordering, QR/card,
loyalty, marketplace, multi-currency credit portability) and deeper i18n
(country product gates, FX journals, residency) are tracked as competitive
follow-ons. Foundations for currency/country/KYC/tax gates live in
`src/i18n/regionConfig.ts`.
