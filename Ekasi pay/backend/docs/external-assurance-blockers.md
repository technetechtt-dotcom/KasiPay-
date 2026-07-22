# External assurance blockers

These items cannot be completed from the repository alone. They remain required
before enabling regulated products or live customer funds.

| Item | Owner | Status |
|---|---|---|
| External accounting / ledger model review | Named finance auditor | **Blocked** — schedule review against `docs/critical-financial-controls.md` and reconcile script outputs |
| External penetration test + high-severity remediation | Named security firm | **Blocked** — engage after staging with production-like data |
| Certified payment / utility provider integration | Product + provider | **Blocked** — requires contracted credentials and certification evidence |
| Private KYC object storage + malware scanner live wiring | Platform ops | Engineering adapters exist; production credentials and scanner callbacks must be connected |
| Centralized monitoring alert routing proof | Platform ops | Configure `MONITORING_PROVIDER`/`MONITORING_DSN` and verify paging to on-call |
| Settlement end-to-end with live provider statements | Finance ops | Requires contracted settlement files |
| Production money contract sign-off | Finance + engineering | Staging branch expand shows pre-existing wallet↔legacy-ledger drift; contract only after written sign-off |
| Host `pg_dump`/`pg_restore` restore drill | Platform ops | Local runners may lack client tools; use Neon branch fork + PITR evidence when `BACKUP_PROVIDER=neon` |

## Staging branch drill notes (2026-07-22)

Disposable Neon branch `ci-harden-2026-07-22` (`br-small-bread-adccsed1`):

- Marked `001_baseline`, applied money expand + contract on a copy of production-like data.
- Column-level money conversion: **0 precision errors / 0 column mismatches**.
- Wallet↔legacy ledger reconcile: **FAIL** (3 wallets with pre-existing drift) — do not treat as green for go-live.
- Migration `008` initially failed on name collision (`loans`); fixed by renaming regulated table to `regulated_loans`.

Regulated product flags must remain `false` until the matching evidence rows are
approved in `evidence/production-readiness.json`.
