# External assurance blockers

These items cannot be completed from the repository alone. They remain required
before enabling regulated products or live customer funds.

| Item | Owner | Status |
|---|---|---|
| External accounting / ledger model review | Named finance auditor | **Blocked** — schedule review against `docs/critical-financial-controls.md` and reconcile script outputs |
| External penetration test + high-severity remediation | Named security firm | **Blocked** — engage after staging with production-like data |
| Certified payment / utility provider integration | Product + provider | **Blocked** — requires contracted credentials and certification evidence |
| Private KYC object storage + malware scanner live wiring | Platform ops | Adapters + **dev stubs** (`npm run dev:storage-signer`, `npm run dev:malware-scan`); production credentials still required |
| Centralized monitoring alert routing proof | Platform ops | Run `npm run alerts:verify` with real DSN; confirm on-call page |
| Immutable audit sink live destination | Platform ops | HTTP sink + `npm run audit:deliver` wired; needs real `AUDIT_SINK_*` |
| Settlement end-to-end with live provider statements | Finance ops | Synthetic proof: `npm run settlement:e2e-proof`; live bank files still blocked |
| Production money contract sign-off | Finance + engineering | Staging branch expand shows pre-existing wallet↔legacy-ledger drift; contract only after written sign-off |
| Host `pg_dump`/`pg_restore` restore drill | Platform ops | Local runners may lack client tools; use Neon branch fork + PITR evidence when `BACKUP_PROVIDER=neon` |
| Shared Redis in production | Platform ops | `RATE_LIMIT_REDIS_URL` now required outside dev/test; provision managed Redis |

## Engineering scaffolding added (2026-07-22)

- Failure drills: `DRILL_ADAPTER=local npm run drill -- <type>`
- Settlement fixture E2E: `fixtures/settlement/phase6-v1.sample.csv`
- Audit outbox worker interval when `AUDIT_SINK_*` set at API boot

## Staging branch drill notes (2026-07-22)

Disposable Neon branch `ci-harden-2026-07-22` (`br-small-bread-adccsed1`):

- Marked `001_baseline`, applied money expand + contract on a copy of production-like data.
- Column-level money conversion: **0 precision errors / 0 column mismatches**.
- Wallet↔legacy ledger reconcile: **FAIL** (3 wallets with pre-existing drift) — do not treat as green for go-live.
- Migrations through `012` applied on the disposable branch after PII backfill.

Regulated product flags must remain `false` until the matching evidence rows are
approved in `evidence/production-readiness.json`.
